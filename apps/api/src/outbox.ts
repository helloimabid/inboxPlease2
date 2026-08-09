import type { Bindings, QueueJob } from './env';

const LEASE_SECONDS = 90;
const SWEEP_LIMIT = 100;

interface OutboxRow {
  id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
}

export interface OutboxSweepResult {
  selected: number;
  dispatched: number;
}

const queueJobTypes = new Set<QueueJob['type']>([
  'meta.webhook',
  'payment.validate',
  'catalog.reindex',
  'order.status.dispatch',
  'settings.cache.refresh',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeOutboxJob(job: QueueJob): string {
  return JSON.stringify(job);
}

export function parseOutboxJob(row: Pick<OutboxRow, 'id' | 'event_type' | 'payload_json'>): QueueJob {
  const value: unknown = JSON.parse(row.payload_json);
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    !queueJobTypes.has(value.type as QueueJob['type']) ||
    value.type !== row.event_type ||
    value.eventId !== row.id
  ) {
    throw new Error('Outbox payload does not match its envelope');
  }
  return value as QueueJob;
}

/**
 * Returns an INSERT statement that can be included in the same D1 batch as a
 * domain mutation. The optional predicate is trusted, application-owned SQL;
 * its values follow the three outbox values in positional binding order.
 */
export function prepareOutboxInsert(
  db: D1Database,
  job: QueueJob,
  predicate?: { sql: string; values: unknown[] },
): D1PreparedStatement {
  const condition = predicate ? ` WHERE (${predicate.sql})` : '';
  return db.prepare(
    `INSERT OR IGNORE INTO outbox_events
       (id, event_type, payload_json, status, available_at, updated_at)
     SELECT ?, ?, ?, 'pending', unixepoch(), unixepoch()${condition}`,
  ).bind(
    job.eventId,
    job.type,
    serializeOutboxJob(job),
    ...(predicate?.values ?? []),
  );
}

export function outboxRetryDelaySeconds(attempts: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(attempts, 1), 8));
}

async function releaseForRetry(
  env: Bindings,
  eventId: string,
  leaseToken: string,
  attempts: number,
  error: unknown,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'pending', available_at = unixepoch() + ?3,
         lease_token = NULL, lease_expires_at = NULL,
         last_error = ?4, updated_at = unixepoch()
     WHERE id = ?1 AND status = 'dispatching' AND lease_token = ?2`,
  ).bind(
    eventId,
    leaseToken,
    outboxRetryDelaySeconds(attempts),
    String(error).slice(0, 500),
  ).run();
}

async function failMalformedEvent(
  env: Bindings,
  eventId: string,
  leaseToken: string,
  error: unknown,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
         last_error = ?3, updated_at = unixepoch()
     WHERE id = ?1 AND status = 'dispatching' AND lease_token = ?2`,
  ).bind(eventId, leaseToken, String(error).slice(0, 500)).run();
}

/**
 * Claims and publishes one event. Queue idempotency uses the outbox event ID,
 * so a lease recovery may safely enqueue the same event more than once.
 */
export async function dispatchOutboxEvent(env: Bindings, eventId: string): Promise<boolean> {
  const leaseToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'dispatching', attempts = attempts + 1,
         lease_token = ?2, lease_expires_at = unixepoch() + ?3,
         last_error = NULL, updated_at = unixepoch()
     WHERE id = ?1 AND (
       (status = 'pending' AND available_at <= unixepoch()) OR
       (status = 'dispatching' AND lease_expires_at <= unixepoch())
     )`,
  ).bind(eventId, leaseToken, LEASE_SECONDS).run();
  if ((claimed.meta.changes ?? 0) !== 1) return false;

  const row = await env.DB.prepare(
    `SELECT id, event_type, payload_json, attempts
     FROM outbox_events
     WHERE id = ?1 AND status = 'dispatching' AND lease_token = ?2`,
  ).bind(eventId, leaseToken).first<OutboxRow>();
  if (!row) return false;

  let job: QueueJob;
  try {
    job = parseOutboxJob(row);
  } catch (error) {
    await failMalformedEvent(env, eventId, leaseToken, error);
    console.error('Malformed outbox event', eventId, error);
    return false;
  }

  // Guard against missing or malformed Queue binding in test/dev environments.
  if (!env.JOBS || typeof (env.JOBS as unknown as { send?: unknown }).send !== 'function') {
    const error = new TypeError('Queue binding JOBS is not available or missing send()');
    await releaseForRetry(env, eventId, leaseToken, row.attempts, error);
    console.error('Outbox enqueue failed (missing JOBS binding)', eventId, job.type, error);
    return false;
  }
  try {
    await env.JOBS.send(job);
  } catch (error) {
    await releaseForRetry(env, eventId, leaseToken, row.attempts, error);
    console.error('Outbox enqueue failed', eventId, job.type, error);
    return false;
  }

  // A row becomes dispatched only after Queue has accepted the message.
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'dispatched', dispatched_at = unixepoch(),
         lease_token = NULL, lease_expires_at = NULL,
         last_error = NULL, updated_at = unixepoch()
     WHERE id = ?1 AND status = 'dispatching' AND lease_token = ?2`,
  ).bind(eventId, leaseToken).run();
  return true;
}

/** Keep a committed HTTP mutation successful even if the eager enqueue path is
 * temporarily unavailable; the scheduled sweep remains the source of repair. */
export async function dispatchOutboxAfterCommit(env: Bindings, eventId: string): Promise<void> {
  try {
    await dispatchOutboxEvent(env, eventId);
  } catch (error) {
    console.error('Immediate outbox dispatch failed', eventId, error);
  }
}

export async function sweepOutbox(env: Bindings): Promise<OutboxSweepResult> {
  const candidates = await env.DB.prepare(
    `SELECT id FROM outbox_events
     WHERE (status = 'pending' AND available_at <= unixepoch())
        OR (status = 'dispatching' AND lease_expires_at <= unixepoch())
     ORDER BY created_at ASC
     LIMIT ?1`,
  ).bind(SWEEP_LIMIT).all<{ id: string }>();

  let dispatched = 0;
  for (const { id } of candidates.results) {
    try {
      if (await dispatchOutboxEvent(env, id)) dispatched += 1;
    } catch (error) {
      // Keep sweeping other tenants/events if one D1 operation is malformed or
      // temporarily unavailable. Its lease will expire for the next sweep.
      console.error('Scheduled outbox dispatch failed', id, error);
    }
  }
  return { selected: candidates.results.length, dispatched };
}
