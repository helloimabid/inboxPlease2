import { Hono } from 'hono';
import type { Context } from 'hono';
import { flag } from '../config';
import { insertWebhookOnce, markWebhook, stableEventId } from '../db';
import type { AppEnv, MetaWebhookPayload, PaymentQueueJob } from '../env';
import { ApiError } from '../errors';
import { isActionableMetaEvent, metaPayloadEventId } from '../integrations/meta';
import { verifySslCommerzIpnHash } from '../integrations/sslcommerz';
import { constantTimeEqual, verifyMetaSignature } from '../security';
import { BodyTooLargeError, readBodyBounded } from '../bounded-body';
import { facebookMessagingAppSecret } from '../integrations/facebook-config';

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

async function canRetryFailedWebhook(
  c: Context<AppEnv>,
  provider: 'meta' | 'sslcommerz',
  eventId: string,
): Promise<boolean> {
  const existing = await c.env.DB.prepare(
    'SELECT status FROM webhook_events WHERE provider = ?1 AND event_id = ?2',
  ).bind(provider, eventId).first<{ status: string }>();
  if (existing?.status !== 'failed') return false;
  await c.env.DB.prepare(
    `UPDATE webhook_events SET status = 'received', last_error = NULL
     WHERE provider = ?1 AND event_id = ?2`,
  ).bind(provider, eventId).run();
  return true;
}

function payloadFromText(contentType: string, text: string): Record<string, string> {
  if (contentType.includes('application/json')) {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON');
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === 'string' ? item : String(item ?? ''),
    ]));
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

export const webhookRoutes = new Hono<AppEnv>()
  .get('/meta', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token') ?? '';
    const challenge = c.req.query('hub.challenge');
    if (
      mode === 'subscribe' && challenge && c.env.META_VERIFY_TOKEN &&
      constantTimeEqual(token, c.env.META_VERIFY_TOKEN)
    ) return c.text(challenge, 200);
    throw new ApiError(403, 'META_VERIFICATION_FAILED', 'Meta webhook verification failed');
  })
  .post('/meta', async (c) => {
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    if (declaredLength > MAX_WEBHOOK_BYTES) {
      throw new ApiError(413, 'WEBHOOK_TOO_LARGE', 'Webhook payload exceeds 2 MiB');
    }
    let rawBody: ArrayBuffer;
    try {
      rawBody = await readBodyBounded(c.req.raw.body, MAX_WEBHOOK_BYTES, declaredLength);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new ApiError(413, 'WEBHOOK_TOO_LARGE', 'Webhook payload exceeds 2 MiB');
      }
      throw error;
    }
    const appSecret = facebookMessagingAppSecret(c.env);
    const verified = await verifyMetaSignature(
      c.req.header('X-Hub-Signature-256') ?? null,
      rawBody,
      appSecret,
    );
    if (!verified) throw new ApiError(401, 'INVALID_META_SIGNATURE', 'Invalid Meta webhook signature');

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as MetaWebhookPayload;
    } catch {
      throw new ApiError(400, 'INVALID_WEBHOOK_JSON', 'Webhook body is not valid JSON');
    }
    if (payload.object !== 'page' || !Array.isArray(payload.entry)) {
      throw new ApiError(422, 'INVALID_META_PAYLOAD', 'Expected a Meta Page webhook payload');
    }
    const eventId = await metaPayloadEventId(payload);
    const inserted = await insertWebhookOnce(c.env.DB, 'meta', eventId);
    if (!inserted && !(await canRetryFailedWebhook(c, 'meta', eventId))) {
      return c.json({ ok: true, duplicate: true }, 200);
    }
    const actionable = payload.entry.some((entry) =>
      (entry.messaging ?? []).some(isActionableMetaEvent),
    );
    if (!actionable) {
      await markWebhook(c.env.DB, 'meta', eventId, 'ignored');
      return c.json({ ok: true, ignored: true }, 200);
    }
    try {
      await c.env.JOBS.send({ type: 'meta.webhook', eventId, payload });
    } catch (error) {
      await markWebhook(c.env.DB, 'meta', eventId, 'failed', String(error).slice(0, 500));
      throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Webhook could not be queued');
    }
    return c.json({ ok: true, accepted: true }, 202);
  })
  .post('/sslcommerz', async (c) => {
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    let rawBytes: ArrayBuffer;
    try {
      rawBytes = await readBodyBounded(c.req.raw.body, MAX_WEBHOOK_BYTES, declaredLength);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new ApiError(413, 'WEBHOOK_TOO_LARGE', 'Webhook payload exceeds 2 MiB');
      }
      throw error;
    }
    const rawBody = new TextDecoder().decode(rawBytes);
    let payload: Record<string, string>;
    try {
      payload = payloadFromText(c.req.header('Content-Type') ?? '', rawBody);
    } catch {
      throw new ApiError(400, 'INVALID_PAYMENT_CALLBACK', 'Invalid payment callback body');
    }
    const transactionId = payload.tran_id;
    const validationId = payload.val_id;
    const providerStatus = payload.status?.toUpperCase();
    if (!transactionId || !providerStatus) {
      throw new ApiError(422, 'INVALID_PAYMENT_CALLBACK', 'Payment callback is missing required fields');
    }
    if (flag(c.env.PAYMENTS_ENABLED)) {
      if (
        !c.env.SSLCOMMERZ_STORE_PASSWORD ||
        !verifySslCommerzIpnHash(payload, c.env.SSLCOMMERZ_STORE_PASSWORD)
      ) {
        throw new ApiError(401, 'INVALID_PAYMENT_SIGNATURE', 'Invalid SSLCommerz callback signature');
      }
    }
    const eventId = await stableEventId([
      'sslcommerz', transactionId, validationId ?? '', providerStatus,
    ]);
    const inserted = await insertWebhookOnce(c.env.DB, 'sslcommerz', eventId);
    if (!inserted && !(await canRetryFailedWebhook(c, 'sslcommerz', eventId))) {
      return c.json({ ok: true, duplicate: true }, 200);
    }
    if (!flag(c.env.PAYMENTS_ENABLED)) {
      await markWebhook(c.env.DB, 'sslcommerz', eventId, 'ignored');
      return c.json({ ok: true, paymentsDisabled: true }, 202);
    }
    if (['FAILED', 'CANCELLED'].includes(providerStatus)) {
      // The IPN hash above authenticates this terminal provider signal. Apply
      // it only to the exact pending transaction; a late failure can never
      // overwrite an already-paid order. Clearing the pointer permits a new
      // checkout while payment_attempts retains the complete audit trail.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE orders SET payment_status = 'failed', payment_transaction_id = NULL,
             updated_at = unixepoch()
           WHERE payment_transaction_id = ?1 AND payment_status = 'pending'`,
        ).bind(transactionId),
        c.env.DB.prepare(
          `UPDATE payment_attempts SET status = 'cancelled', last_error = ?2,
             updated_at = unixepoch()
           WHERE transaction_id = ?1 AND status IN ('initializing', 'pending', 'unknown')`,
        ).bind(transactionId, `Provider reported ${providerStatus}`),
      ]);
      await markWebhook(c.env.DB, 'sslcommerz', eventId, 'processed');
      return c.json({ ok: true, paymentFailed: true }, 200);
    }
    if (!validationId || !['VALID', 'VALIDATED'].includes(providerStatus)) {
      await markWebhook(c.env.DB, 'sslcommerz', eventId, 'ignored');
      return c.json({ ok: true, ignored: true }, 200);
    }
    const job: PaymentQueueJob = {
      type: 'payment.validate',
      eventId,
      payload,
    };
    try {
      await c.env.JOBS.send(job);
    } catch (error) {
      await markWebhook(c.env.DB, 'sslcommerz', eventId, 'failed', String(error).slice(0, 500));
      throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Payment callback could not be queued');
    }
    // No payment state changes here. The queue consumer validates with SSLCommerz first.
    return c.json({ ok: true, accepted: true }, 202);
  });
