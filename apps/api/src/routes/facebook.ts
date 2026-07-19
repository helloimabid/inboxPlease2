import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { MERCHANT_ADMIN_ROLES, requireRole } from '../auth';
import type { AppEnv, Bindings } from '../env';
import { ApiError, jsonOk } from '../errors';
import {
  FACEBOOK_PAGE_PERMISSIONS,
  hasFacebookMessagingTask,
  FacebookGraphError,
  exchangeFacebookCode,
  facebookAuthorizationUrl,
  facebookGrantedPermissions,
  facebookPages,
  subscribeFacebookPage,
  unsubscribeFacebookPage,
} from '../integrations/facebook-onboarding';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../secret-envelope';
import { base64Encode, sha256Name } from '../security';
import { validationHook } from '../validation';
import { flag } from '../config';

const STATE_TTL_SECONDS = 10 * 60;
const PAGE_SELECTION_TTL_SECONDS = 60 * 60;
const PAGE_OPERATION_TTL_SECONDS = 120;
const PAGE_RECONCILE_INTERVAL_SECONDS = 60;
const PAGE_RECONCILE_CONFIRMATIONS = 3;

const pageParamSchema = z.object({
  pageId: z.string().regex(/^\d{1,32}$/),
});
const approveSchema = z.object({ enableAiMessaging: z.boolean() }).strict();
const enableSchema = z.object({ enabled: z.boolean() }).strict();

interface OnboardingRow {
  id: string;
  user_id: string;
  merchant_id: string;
  facebook_user_id: string;
  status: string;
  granted_permissions_json: string;
  expires_at: number;
  error_code: string | null;
  consumed_at: number | null;
  created_at: number;
}

interface CandidateRow {
  session_id: string;
  page_id: string;
  name: string;
  access_token_encrypted: string;
  tasks_json: string;
}

interface PageConnectionRow {
  id: string;
  name: string;
  meta_page_access_token: string | null;
  connected_at: number | null;
  meta_subscription_status: string;
  meta_permissions_json: string;
  meta_tasks_json: string;
  messaging_ready_at: number | null;
  ai_messaging_enabled: number;
  ai_messaging_approved_at: number | null;
  ai_messaging_disabled_at: number | null;
  disconnected_at: number | null;
  meta_last_error: string | null;
  meta_connection_generation: number;
  meta_operation_id: string | null;
  meta_operation_kind: string | null;
  meta_operation_expires_at: number | null;
}

export async function cleanupExpiredMetaOnboarding(env: Bindings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM meta_page_candidates
       WHERE session_id IN (
         SELECT id FROM meta_onboarding_sessions
         WHERE expires_at < unixepoch() ORDER BY expires_at ASC LIMIT 100
       )`,
    ),
    env.DB.prepare(
      `DELETE FROM meta_onboarding_sessions
       WHERE id IN (
         SELECT id FROM meta_onboarding_sessions
         WHERE expires_at < unixepoch() - 604800
         ORDER BY expires_at ASC LIMIT 100
       )`,
    ),
  ]);
}

interface ReconcilePageRow {
  id: string;
  merchant_id: string;
  meta_page_access_token: string | null;
  meta_subscription_desired: number;
  meta_connection_generation: number;
  meta_reconcile_failures: number;
}

async function failFacebookPageReconcile(
  env: Bindings,
  row: ReconcilePageRow,
  operationGeneration: number,
  operationId: string,
  errorCode: string,
  permanent: boolean,
): Promise<void> {
  const failures = Math.min(row.meta_reconcile_failures + 1, 10);
  const retryDelay = Math.min(
    PAGE_RECONCILE_INTERVAL_SECONDS * (2 ** Math.min(failures - 1, 6)),
    60 * 60,
  );
  await env.DB.prepare(
    `UPDATE store_pages SET
       ai_messaging_enabled = 0,
       ai_messaging_disabled_at = unixepoch(),
       meta_subscription_status = CASE
         WHEN meta_subscription_desired = 1
           THEN 'subscription_failed' ELSE 'unsubscribe_failed' END,
       messaging_ready_at = NULL,
       meta_last_error = ?5,
       meta_reconcile_attempts = 0,
       meta_reconcile_failures = ?6,
       meta_reconcile_after = CASE
         WHEN ?7 = 1 THEN NULL ELSE unixepoch() + ?8 END,
       meta_operation_id = NULL, meta_operation_kind = NULL,
       meta_operation_expires_at = NULL, updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2
       AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
  ).bind(
    row.id,
    row.merchant_id,
    operationGeneration,
    operationId,
    errorCode,
    failures,
    permanent ? 1 : 0,
    retryDelay,
  ).run();
}

async function reconcileFacebookPage(
  env: Bindings,
  row: ReconcilePageRow,
): Promise<boolean> {
  const desired = row.meta_subscription_desired === 1;
  const operationGeneration = row.meta_connection_generation + 1;
  const operationId = crypto.randomUUID();
  const operationKind = desired ? 'connect' : 'disconnect';
  const acquired = await env.DB.prepare(
    `UPDATE store_pages SET
       ai_messaging_enabled = CASE
         WHEN ?4 = 0 THEN 0 ELSE ai_messaging_enabled END,
       ai_messaging_disabled_at = CASE
         WHEN ?4 = 0 THEN COALESCE(ai_messaging_disabled_at, unixepoch())
         ELSE ai_messaging_disabled_at END,
       meta_subscription_status = CASE
         WHEN ?4 = 0 THEN 'disconnecting'
         WHEN meta_subscription_status IN (
           'not_subscribed', 'disconnected', 'subscription_failed'
         ) THEN 'connecting'
         ELSE meta_subscription_status END,
       messaging_ready_at = CASE
         WHEN ?4 = 0 THEN NULL ELSE messaging_ready_at END,
       meta_connection_generation = ?5,
       meta_operation_id = ?6, meta_operation_kind = ?7,
       meta_operation_expires_at = unixepoch() + ?8,
       updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
       AND meta_subscription_desired = ?4
       AND meta_reconcile_after IS NOT NULL
       AND meta_reconcile_after <= unixepoch()
       AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())`,
  ).bind(
    row.id,
    row.merchant_id,
    row.meta_connection_generation,
    desired ? 1 : 0,
    operationGeneration,
    operationId,
    operationKind,
    PAGE_OPERATION_TTL_SECONDS,
  ).run();
  if ((acquired.meta.changes ?? 0) !== 1) return false;

  if (!row.meta_page_access_token || !isEncryptedSecret(row.meta_page_access_token)) {
    await failFacebookPageReconcile(
      env,
      row,
      operationGeneration,
      operationId,
      'FACEBOOK_RECONCILE_TOKEN_INVALID',
      true,
    );
    return false;
  }

  let token: string;
  try {
    token = await decryptSecret(row.meta_page_access_token, encryptionKey(env));
  } catch {
    await failFacebookPageReconcile(
      env,
      row,
      operationGeneration,
      operationId,
      'FACEBOOK_RECONCILE_TOKEN_DECRYPT_FAILED',
      true,
    );
    return false;
  }

  try {
    if (desired) await subscribeFacebookPage(env, row.id, token);
    else await unsubscribeFacebookPage(env, row.id, token);
  } catch (error) {
    const safeCode = error instanceof FacebookGraphError
      ? error.safeCode
      : 'FACEBOOK_RECONCILE_GRAPH_FAILED';
    const retryable = error instanceof FacebookGraphError
      ? error.retryable
      : safeCode === 'FACEBOOK_RECONCILE_GRAPH_FAILED';
    await failFacebookPageReconcile(
      env,
      row,
      operationGeneration,
      operationId,
      safeCode,
      !retryable,
    );
    return false;
  }

  if (desired) {
    await env.DB.prepare(
      `UPDATE store_pages SET
         meta_subscription_status = 'subscribed',
         messaging_ready_at = COALESCE(messaging_ready_at, unixepoch()),
         connected_at = COALESCE(connected_at, unixepoch()),
         disconnected_at = NULL, meta_last_error = NULL,
         meta_reconcile_failures = 0,
         meta_reconcile_after = CASE
           WHEN meta_reconcile_attempts + 1 >= ?5 THEN NULL
           ELSE unixepoch() + ?6 END,
         meta_reconcile_attempts = CASE
           WHEN meta_reconcile_attempts + 1 >= ?5 THEN 0
           ELSE meta_reconcile_attempts + 1 END,
         meta_operation_id = NULL, meta_operation_kind = NULL,
         meta_operation_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2
         AND meta_connection_generation = ?3
         AND meta_operation_id = ?4 AND meta_subscription_desired = 1`,
    ).bind(
      row.id,
      row.merchant_id,
      operationGeneration,
      operationId,
      PAGE_RECONCILE_CONFIRMATIONS,
      PAGE_RECONCILE_INTERVAL_SECONDS,
    ).run();
  } else {
    await env.DB.prepare(
      `UPDATE store_pages SET
         meta_subscription_status = 'disconnected', messaging_ready_at = NULL,
         ai_messaging_enabled = 0, connected_at = NULL,
         disconnected_at = COALESCE(disconnected_at, unixepoch()),
         meta_last_error = NULL,
         meta_reconcile_failures = 0,
         meta_page_access_token = CASE
           WHEN meta_reconcile_attempts + 1 >= ?5 THEN NULL
           ELSE meta_page_access_token END,
         meta_reconcile_after = CASE
           WHEN meta_reconcile_attempts + 1 >= ?5 THEN NULL
           ELSE unixepoch() + ?6 END,
         meta_reconcile_attempts = CASE
           WHEN meta_reconcile_attempts + 1 >= ?5 THEN 0
           ELSE meta_reconcile_attempts + 1 END,
         meta_operation_id = NULL, meta_operation_kind = NULL,
         meta_operation_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2
         AND meta_connection_generation = ?3
         AND meta_operation_id = ?4 AND meta_subscription_desired = 0`,
    ).bind(
      row.id,
      row.merchant_id,
      operationGeneration,
      operationId,
      PAGE_RECONCILE_CONFIRMATIONS,
      PAGE_RECONCILE_INTERVAL_SECONDS,
    ).run();
  }
  return true;
}

export async function reconcileFacebookPageSubscriptions(
  env: Bindings,
): Promise<{ selected: number; reconciled: number }> {
  const due = await env.DB.prepare(
    `SELECT pages.id, pages.merchant_id, pages.meta_page_access_token,
            pages.meta_subscription_desired, pages.meta_connection_generation,
            pages.meta_reconcile_failures
     FROM store_pages AS pages
     JOIN merchants ON merchants.id = pages.merchant_id
     WHERE pages.meta_reconcile_after IS NOT NULL
       AND pages.meta_reconcile_after <= unixepoch()
       AND (pages.meta_operation_id IS NULL
         OR pages.meta_operation_expires_at < unixepoch())
       AND (pages.meta_subscription_desired = 0 OR merchants.status = 'active')
     ORDER BY pages.meta_reconcile_after ASC LIMIT 25`,
  ).all<ReconcilePageRow>();
  const results = await Promise.all(
    due.results.map((row) => reconcileFacebookPage(env, row)),
  );
  return {
    selected: due.results.length,
    reconciled: results.filter(Boolean).length,
  };
}

async function compensateStaleDisconnect(
  env: Bindings,
  merchantId: string,
  pageId: string,
): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT meta_page_access_token, meta_subscription_status,
            meta_connection_generation, meta_operation_kind,
            messaging_ready_at, connected_at, ai_messaging_enabled,
            meta_subscription_desired
     FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(pageId, merchantId).first<{
    meta_page_access_token: string | null;
    meta_subscription_status: string;
    meta_connection_generation: number;
    meta_operation_kind: string | null;
    messaging_ready_at: number | null;
    connected_at: number | null;
    ai_messaging_enabled: number;
    meta_subscription_desired: number;
  }>();
  if (!current || current.meta_subscription_desired !== 1) return;

  // Acquire a fresh lease before the compensating Graph call. An unexpired
  // connector already owns the external-call boundary and is allowed to
  // finish; an exact generation predicate makes a newer local decision win.
  const operationId = crypto.randomUUID();
  const operationGeneration = current.meta_connection_generation + 1;
  const acquired = await env.DB.prepare(
    `UPDATE store_pages SET ai_messaging_enabled = 0,
       ai_messaging_disabled_at = CASE
         WHEN ai_messaging_enabled = 1 THEN unixepoch()
         ELSE ai_messaging_disabled_at END,
       meta_subscription_status = 'connecting',
       messaging_ready_at = NULL,
       meta_last_error = 'FACEBOOK_SUBSCRIPTION_RECONCILING',
       meta_connection_generation = ?4,
       meta_operation_id = ?5, meta_operation_kind = 'connect',
       meta_operation_expires_at = unixepoch() + ?6,
       updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
       AND meta_subscription_desired = 1
       AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())`,
  ).bind(
    pageId,
    merchantId,
    current.meta_connection_generation,
    operationGeneration,
    operationId,
    PAGE_OPERATION_TTL_SECONDS,
  ).run();
  if ((acquired.meta.changes ?? 0) !== 1) return;

  let restored = false;
  if (
    current.meta_page_access_token &&
    isEncryptedSecret(current.meta_page_access_token)
  ) {
    try {
      const token = await decryptSecret(current.meta_page_access_token, encryptionKey(env));
      await subscribeFacebookPage(env, pageId, token);
      restored = true;
    } catch {
      restored = false;
    }
  }
  if (restored) {
    await env.DB.prepare(
      `UPDATE store_pages SET
         meta_subscription_status = 'subscribed',
         messaging_ready_at = COALESCE(?5, unixepoch()),
         connected_at = COALESCE(?6, connected_at, unixepoch()),
         ai_messaging_enabled = ?7,
         ai_messaging_disabled_at = CASE
           WHEN ?7 = 1 THEN NULL ELSE ai_messaging_disabled_at END,
         disconnected_at = NULL, meta_last_error = NULL,
         meta_reconcile_attempts = 0,
         meta_reconcile_failures = 0,
         meta_reconcile_after = unixepoch() + ?8,
         meta_operation_id = NULL, meta_operation_kind = NULL,
         meta_operation_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2
         AND meta_connection_generation = ?3
         AND meta_operation_id = ?4 AND meta_operation_kind = 'connect'`,
    ).bind(
      pageId,
      merchantId,
      operationGeneration,
      operationId,
      current.messaging_ready_at,
      current.connected_at,
      current.ai_messaging_enabled,
      PAGE_RECONCILE_INTERVAL_SECONDS,
    ).run();
    return;
  }

  await env.DB.prepare(
    `UPDATE store_pages SET ai_messaging_enabled = 0,
       ai_messaging_disabled_at = unixepoch(),
       meta_subscription_status = 'subscription_failed',
       messaging_ready_at = NULL,
       meta_last_error = 'FACEBOOK_SUBSCRIPTION_RECONCILE_FAILED',
       meta_reconcile_attempts = 0,
       meta_reconcile_failures = meta_reconcile_failures + 1,
       meta_reconcile_after = unixepoch() + ?5,
       meta_operation_id = NULL, meta_operation_kind = NULL,
       meta_operation_expires_at = NULL, updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
       AND meta_operation_id = ?4 AND meta_operation_kind = 'connect'`,
  ).bind(
    pageId,
    merchantId,
    operationGeneration,
    operationId,
    PAGE_RECONCILE_INTERVAL_SECONDS,
  ).run();
}

async function compensateStaleConnect(
  env: Bindings,
  merchantId: string,
  pageId: string,
  candidateToken: string,
  candidateTokenEncrypted: string,
): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT meta_subscription_status, meta_operation_kind,
            meta_connection_generation, meta_subscription_desired
     FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(pageId, merchantId).first<{
    meta_subscription_status: string;
    meta_operation_kind: string | null;
    meta_connection_generation: number;
    meta_subscription_desired: number;
  }>();
  if (!current || current.meta_subscription_desired !== 0) return;
  const operationId = crypto.randomUUID();
  const operationGeneration = current.meta_connection_generation + 1;
  const acquired = await env.DB.prepare(
    `UPDATE store_pages SET ai_messaging_enabled = 0,
       ai_messaging_disabled_at = unixepoch(),
       meta_subscription_status = 'disconnecting', messaging_ready_at = NULL,
       meta_page_access_token = COALESCE(meta_page_access_token, ?7),
       meta_connection_generation = ?4,
       meta_operation_id = ?5, meta_operation_kind = 'disconnect',
       meta_operation_expires_at = unixepoch() + ?6,
       updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
       AND meta_subscription_desired = 0
       AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())`,
  ).bind(
    pageId,
    merchantId,
    current.meta_connection_generation,
    operationGeneration,
    operationId,
    PAGE_OPERATION_TTL_SECONDS,
    candidateTokenEncrypted,
  ).run();
  if ((acquired.meta.changes ?? 0) !== 1) return;

  try {
    await unsubscribeFacebookPage(env, pageId, candidateToken);
    await env.DB.prepare(
      `UPDATE store_pages SET
         meta_subscription_status = 'disconnected', messaging_ready_at = NULL,
         ai_messaging_enabled = 0, connected_at = NULL,
         disconnected_at = unixepoch(), meta_last_error = NULL,
         meta_reconcile_attempts = 0,
         meta_reconcile_failures = 0,
         meta_reconcile_after = unixepoch() + ?5,
         meta_operation_id = NULL, meta_operation_kind = NULL,
         meta_operation_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2
         AND meta_connection_generation = ?3
         AND meta_operation_id = ?4 AND meta_operation_kind = 'disconnect'`,
    ).bind(
      pageId,
      merchantId,
      operationGeneration,
      operationId,
      PAGE_RECONCILE_INTERVAL_SECONDS,
    ).run();
  } catch {
    await env.DB.prepare(
      `UPDATE store_pages SET meta_subscription_status = 'unsubscribe_failed',
         messaging_ready_at = NULL, ai_messaging_enabled = 0,
         meta_last_error = 'FACEBOOK_UNSUBSCRIBE_RECONCILE_FAILED',
         meta_reconcile_attempts = 0,
         meta_reconcile_failures = meta_reconcile_failures + 1,
         meta_reconcile_after = unixepoch() + ?5,
         meta_operation_id = NULL, meta_operation_kind = NULL,
         meta_operation_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2
         AND meta_connection_generation = ?3
         AND meta_operation_id = ?4 AND meta_operation_kind = 'disconnect'`,
    ).bind(
      pageId,
      merchantId,
      operationGeneration,
      operationId,
      PAGE_RECONCILE_INTERVAL_SECONDS,
    ).run();
  }
}

function stringArray(value: string): string[] {
  try {
    const result = JSON.parse(value) as unknown;
    return Array.isArray(result)
      ? result.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function missing(values: readonly string[], required: readonly string[]): string[] {
  const present = new Set(values);
  return required.filter((value) => !present.has(value));
}

function pageReady(row: PageConnectionRow): boolean {
  return Boolean(
    row.messaging_ready_at &&
    row.meta_subscription_status === 'subscribed' &&
    row.meta_page_access_token && isEncryptedSecret(row.meta_page_access_token) &&
    missing(stringArray(row.meta_permissions_json), FACEBOOK_PAGE_PERMISSIONS).length === 0 &&
    hasFacebookMessagingTask(stringArray(row.meta_tasks_json)),
  );
}

function facebookPageLimit(plan: string): number {
  if (plan === 'free') return 1;
  if (plan === 'pro') return 3;
  if (plan === 'business') return 10;
  if (plan === 'enterprise') return Number.MAX_SAFE_INTEGER;
  return 0;
}

function randomState(): string {
  return base64Encode(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function encryptionKey(env: Bindings): string {
  if (!env.META_TOKEN_ENCRYPTION_KEY) {
    throw new ApiError(
      503,
      'FACEBOOK_TOKEN_ENCRYPTION_NOT_CONFIGURED',
      'Facebook Page token encryption is not configured',
    );
  }
  return env.META_TOKEN_ENCRYPTION_KEY;
}

async function assertEncryptionConfigured(env: Bindings): Promise<void> {
  try {
    await encryptSecret('facebook-page-token-configuration-check', encryptionKey(env));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      'FACEBOOK_TOKEN_ENCRYPTION_NOT_CONFIGURED',
      'Facebook Page token encryption is not configured correctly',
    );
  }
}

function dashboardReturnUrl(env: Bindings, result: string): string {
  const configured = (env.DASHBOARD_ORIGIN ?? 'http://localhost:5173')
    .split(',')[0]?.trim() || 'http://localhost:5173';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ApiError(503, 'FACEBOOK_NOT_CONFIGURED', 'Dashboard origin is invalid');
  }
  url.pathname = '/app';
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', 'facebook');
  url.searchParams.set('facebook', result);
  return url.toString();
}

async function setSessionResult(
  env: Bindings,
  sessionId: string,
  status: string,
  errorCode: string | null,
  grantedPermissions?: readonly string[],
) {
  await env.DB.prepare(
    `UPDATE meta_onboarding_sessions
     SET status = ?2, error_code = ?3,
         granted_permissions_json = COALESCE(?4, granted_permissions_json),
         updated_at = unixepoch()
     WHERE id = ?1`,
  ).bind(
    sessionId,
    status,
    errorCode,
    grantedPermissions ? JSON.stringify(grantedPermissions) : null,
  ).run();
}

async function consumeState(env: Bindings, rawState: string): Promise<OnboardingRow | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(rawState)) return null;
  const digest = await sha256Name(['facebook-oauth-state', rawState]);
  const claimed = await env.DB.prepare(
    `UPDATE meta_onboarding_sessions
     SET consumed_at = unixepoch(), status = 'failed',
         error_code = 'CALLBACK_IN_PROGRESS', updated_at = unixepoch()
     WHERE state_digest = ?1 AND status = 'authorization_pending'
       AND consumed_at IS NULL AND expires_at >= unixepoch()`,
  ).bind(digest).run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return env.DB.prepare(
    `SELECT sessions.id, sessions.user_id, sessions.merchant_id,
            sessions.facebook_user_id, sessions.status,
            sessions.granted_permissions_json, sessions.expires_at,
            sessions.error_code, sessions.consumed_at, sessions.created_at
     FROM meta_onboarding_sessions AS sessions
     JOIN users ON users.id = sessions.user_id AND users.status = 'active'
     JOIN merchants ON merchants.id = sessions.merchant_id AND merchants.status = 'active'
     JOIN merchant_memberships AS memberships
       ON memberships.user_id = sessions.user_id
      AND memberships.merchant_id = sessions.merchant_id
      AND memberships.status = 'active'
      AND memberships.role IN ('owner', 'admin')
     WHERE sessions.state_digest = ?1`,
  ).bind(digest).first<OnboardingRow>();
}

function callbackRedirect(c: Context<AppEnv>, result: string) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(dashboardReturnUrl(c.env, result), 303);
}

export const facebookCallbackRoutes = new Hono<AppEnv>().get('/callback', async (c) => {
  const rawState = c.req.query('state') ?? '';
  const session = await consumeState(c.env, rawState);
  if (!session) return callbackRedirect(c, 'invalid-state');

  // Facebook user IDs are app-scoped, so the login app and Messenger app
  // intentionally return different IDs for the same person. Bind the callback
  // to the active InboxPlease user and merchant that created the one-time
  // state instead. Production mounts requireAuth before this route.
  const auth = c.get('auth');
  if (
    !auth || auth.subject !== session.user_id ||
    auth.merchantId !== session.merchant_id
  ) {
    await setSessionResult(c.env, session.id, 'failed', 'CALLBACK_SESSION_MISMATCH');
    return callbackRedirect(c, 'failed');
  }

  if (c.req.query('error')) {
    await setSessionResult(c.env, session.id, 'permission_denied', 'OAUTH_CANCELLED');
    return callbackRedirect(c, 'cancelled');
  }
  const code = c.req.query('code');
  if (!code) {
    await setSessionResult(c.env, session.id, 'failed', 'OAUTH_CODE_MISSING');
    return callbackRedirect(c, 'failed');
  }

  try {
    const userToken = await exchangeFacebookCode(c.env, code);
    const grantedPermissions = await facebookGrantedPermissions(c.env, userToken);
    const missingPermissions = missing(grantedPermissions, FACEBOOK_PAGE_PERMISSIONS);
    if (missingPermissions.length > 0) {
      await setSessionResult(
        c.env,
        session.id,
        'permission_denied',
        'REQUIRED_PAGE_PERMISSIONS_MISSING',
        grantedPermissions,
      );
      return callbackRedirect(c, 'permission-denied');
    }
    const pages = await facebookPages(c.env, userToken);
    if (pages.length === 0) {
      await setSessionResult(
        c.env,
        session.id,
        'no_pages',
        'NO_MANAGEABLE_PAGES',
        grantedPermissions,
      );
      return callbackRedirect(c, 'no-pages');
    }

    const key = encryptionKey(c.env);
    const candidates = await Promise.all(pages.slice(0, 50).map(async (page) => ({
      ...page,
      encryptedToken: await encryptSecret(page.accessToken, key),
    })));
    await c.env.DB.batch([
      ...candidates.map((page) => c.env.DB.prepare(
        `INSERT INTO meta_page_candidates
           (session_id, page_id, name, access_token_encrypted, tasks_json)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(
        session.id,
        page.id,
        page.name,
        page.encryptedToken,
        JSON.stringify(page.tasks),
      )),
      c.env.DB.prepare(
        `UPDATE meta_onboarding_sessions
         SET status = 'pages_ready', error_code = NULL,
             granted_permissions_json = ?2,
             expires_at = unixepoch() + ?3, updated_at = unixepoch()
         WHERE id = ?1`,
      ).bind(session.id, JSON.stringify(grantedPermissions), PAGE_SELECTION_TTL_SECONDS),
    ]);
    return callbackRedirect(c, 'pages-ready');
  } catch (error) {
    const errorCode = error instanceof FacebookGraphError
      ? error.safeCode
      : 'CALLBACK_FAILED';
    await setSessionResult(c.env, session.id, 'failed', errorCode);
    return callbackRedirect(c, 'failed');
  }
});

export const facebookRoutes = new Hono<AppEnv>()
  .get('/connection', async (c) => {
    c.header('Cache-Control', 'no-store');
    const { merchantId, subject } = c.get('auth');
    await cleanupExpiredMetaOnboarding(c.env);
    const [latest, pages] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, user_id, merchant_id, facebook_user_id, status,
                granted_permissions_json, expires_at, error_code,
                consumed_at, created_at
         FROM meta_onboarding_sessions
         WHERE merchant_id = ?1 AND user_id = ?2
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(merchantId, subject).first<OnboardingRow>(),
      c.env.DB.prepare(
        `SELECT id, name, meta_page_access_token, connected_at,
                meta_subscription_status, meta_permissions_json, meta_tasks_json,
                messaging_ready_at, ai_messaging_enabled,
                ai_messaging_approved_at, ai_messaging_disabled_at,
                disconnected_at, meta_last_error, meta_connection_generation,
                meta_operation_id, meta_operation_kind, meta_operation_expires_at
         FROM store_pages WHERE merchant_id = ?1 ORDER BY created_at ASC`,
      ).bind(merchantId).all<PageConnectionRow>(),
    ]);
    const candidates = latest && ['pages_ready', 'completed'].includes(latest.status)
      ? await c.env.DB.prepare(
          `SELECT session_id, page_id, name, access_token_encrypted,
                  tasks_json
           FROM meta_page_candidates WHERE session_id = ?1 ORDER BY name ASC`,
        ).bind(latest.id).all<CandidateRow>()
      : { results: [] as CandidateRow[] };

    const connectedPages = pages.results.map((page) => {
      const ready = pageReady(page);
      const enabled = page.ai_messaging_enabled === 1;
      return {
        id: page.id,
        name: page.name,
        connectedAt: page.connected_at,
        webhookSubscribed: page.meta_subscription_status === 'subscribed',
        aiMessagingReady: ready,
        aiMessagingEnabled: enabled,
        aiMessagingEffective:
          ready && enabled && flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
        aiMessagingApprovedAt: page.ai_messaging_approved_at,
        aiMessagingDisabledAt: page.ai_messaging_disabled_at,
        disconnectedAt: page.disconnected_at,
        lastError: page.meta_last_error,
      };
    });
    const candidatePages = candidates.results.map((page) => {
      const tasks = stringArray(page.tasks_json);
      const eligible = hasFacebookMessagingTask(tasks);
      return {
        id: page.page_id,
        name: page.name,
        tasks,
        eligible,
        missingTasks: eligible ? [] : ['MESSAGING_CAPABILITY'],
      };
    });
    const now = Math.floor(Date.now() / 1000);
    let status = 'not_connected';
    if (connectedPages.some((page) => page.aiMessagingEnabled)) status = 'enabled';
    else if (connectedPages.some((page) => page.aiMessagingReady)) status = 'ready';
    else if (connectedPages.some((page) => page.lastError)) status = 'attention_required';
    else if (candidatePages.length > 0 && latest && latest.expires_at >= now) {
      status = 'page_selection_required';
    } else if (latest?.status === 'authorization_pending' && latest.expires_at >= now) {
      status = 'authorization_pending';
    } else if (latest?.status === 'permission_denied') status = 'permissions_required';
    else if (latest?.status === 'no_pages') status = 'no_pages';
    else if (latest?.status === 'failed') status = 'attention_required';

    const grantedPermissions = latest
      ? stringArray(latest.granted_permissions_json)
      : [];
    return jsonOk(c, {
      status,
      requiredPermissions: [...FACEBOOK_PAGE_PERMISSIONS],
      grantedPermissions,
      allPermissionsGranted:
        missing(grantedPermissions, FACEBOOK_PAGE_PERMISSIONS).length === 0,
      platform: {
        aiEnabled: flag(c.env.AI_ENABLED),
        messagingEnabled: flag(c.env.MESSAGING_ENABLED),
        aiMessagingAvailable:
          flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
      },
      authorizationExpiresAt:
        latest?.status === 'authorization_pending' ? latest.expires_at : null,
      lastError: latest?.error_code ?? null,
      candidates: candidatePages,
      pages: connectedPages,
    });
  })
  .post('/connect', requireRole(...MERCHANT_ADMIN_ROLES), async (c) => {
    c.header('Cache-Control', 'no-store');
    const { merchantId, subject, facebookAccountId } = c.get('auth');
    await cleanupExpiredMetaOnboarding(c.env);
    if (!facebookAccountId || !/^\d{1,32}$/.test(facebookAccountId)) {
      throw new ApiError(
        409,
        'FACEBOOK_LOGIN_REQUIRED',
        'Sign in with Facebook before connecting a Page',
      );
    }
    const facebookAccount = await c.env.DB.prepare(
      `SELECT providerAccountId AS facebook_user_id
       FROM accounts
       WHERE userId = ?1 AND provider = 'facebook' AND providerAccountId = ?2
       LIMIT 1`,
    ).bind(subject, facebookAccountId).first<{ facebook_user_id: string }>();
    if (!facebookAccount) {
      throw new ApiError(
        409,
        'FACEBOOK_LOGIN_REQUIRED',
        'Sign in with Facebook before connecting a Page',
      );
    }
    const state = randomState();
    const authorizationUrl = facebookAuthorizationUrl(c.env, state);
    // Validate the separate encryption key before sending the seller away.
    await assertEncryptionConfigured(c.env);
    const sessionId = crypto.randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM meta_onboarding_sessions
         WHERE merchant_id = ?1 AND user_id = ?2`,
      ).bind(merchantId, subject),
      c.env.DB.prepare(
        `INSERT INTO meta_onboarding_sessions
           (id, state_digest, user_id, merchant_id, facebook_user_id,
            requested_permissions_json, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        sessionId,
        await sha256Name(['facebook-oauth-state', state]),
        subject,
        merchantId,
        facebookAccount.facebook_user_id,
        JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
        expiresAt,
      ),
    ]);
    return jsonOk(c, { authorizationUrl, expiresAt }, 201);
  })
  .post(
    '/pages/:pageId/approve',
    requireRole(...MERCHANT_ADMIN_ROLES),
    zValidator('param', pageParamSchema, validationHook),
    zValidator('json', approveSchema, validationHook),
    async (c) => {
      const { merchantId, subject } = c.get('auth');
      const { pageId } = c.req.valid('param');
      const { enableAiMessaging } = c.req.valid('json');
      const existing = await c.env.DB.prepare(
        'SELECT merchant_id FROM store_pages WHERE id = ?1',
      ).bind(pageId).first<{ merchant_id: string }>();
      if (existing && existing.merchant_id !== merchantId) {
        throw new ApiError(409, 'FACEBOOK_PAGE_ALREADY_CONNECTED', 'Page is already connected');
      }
      const candidate = await c.env.DB.prepare(
        `SELECT candidates.session_id, candidates.page_id, candidates.name,
                candidates.access_token_encrypted, candidates.tasks_json,
                sessions.granted_permissions_json
         FROM meta_page_candidates AS candidates
         JOIN meta_onboarding_sessions AS sessions ON sessions.id = candidates.session_id
         WHERE candidates.page_id = ?1 AND sessions.merchant_id = ?2
           AND sessions.user_id = ?3 AND sessions.status IN ('pages_ready', 'completed')
           AND sessions.expires_at >= unixepoch()
         ORDER BY sessions.created_at DESC LIMIT 1`,
      ).bind(pageId, merchantId, subject).first<CandidateRow & {
        granted_permissions_json: string;
      }>();
      if (!candidate) {
        throw new ApiError(
          404,
          'FACEBOOK_PAGE_CANDIDATE_NOT_FOUND',
          'Authorize Facebook again and select an available Page',
        );
      }
      const permissions = stringArray(candidate.granted_permissions_json);
      const tasks = stringArray(candidate.tasks_json);
      if (missing(permissions, FACEBOOK_PAGE_PERMISSIONS).length > 0) {
        throw new ApiError(
          409,
          'FACEBOOK_PERMISSIONS_MISSING',
          'Required Facebook Page permissions were not granted',
        );
      }
      if (!hasFacebookMessagingTask(tasks)) {
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_TASK_MISSING',
          'Your Facebook profile does not have the Page messaging task',
        );
      }
      if (!isEncryptedSecret(candidate.access_token_encrypted)) {
        throw new ApiError(503, 'FACEBOOK_TOKEN_INVALID', 'Stored Facebook token is invalid');
      }
      // Reserve the globally unique Page ID before the external subscription.
      // A concurrent merchant can never acquire or overwrite the same Page.
      const reservationInsert = await c.env.DB.prepare(
        `INSERT OR IGNORE INTO store_pages (id, merchant_id, name)
         VALUES (?1, ?2, ?3)`,
      ).bind(pageId, merchantId, candidate.name).run();
      const reserved = await c.env.DB.prepare(
        `SELECT merchant_id, meta_subscription_status, meta_connection_generation,
                meta_operation_id, meta_operation_kind, meta_operation_expires_at
         FROM store_pages WHERE id = ?1`,
      ).bind(pageId).first<{
        merchant_id: string;
        meta_subscription_status: string;
        meta_connection_generation: number;
        meta_operation_id: string | null;
        meta_operation_kind: string | null;
        meta_operation_expires_at: number | null;
      }>();
      if (reserved?.merchant_id !== merchantId) {
        throw new ApiError(409, 'FACEBOOK_PAGE_ALREADY_CONNECTED', 'Page is already connected');
      }
      const operationId = crypto.randomUUID();
      const operationGeneration = reserved.meta_connection_generation + 1;
      const acquired = await c.env.DB.prepare(
        `UPDATE store_pages SET name = ?7,
           meta_page_access_token = ?8,
           meta_permissions_json = ?9,
           meta_tasks_json = ?10,
           ai_messaging_enabled = 0,
           ai_messaging_disabled_at = unixepoch(),
           meta_subscription_status = 'connecting',
           messaging_ready_at = NULL,
           meta_last_error = NULL,
           meta_subscription_desired = 1,
           meta_reconcile_after = unixepoch() + ?11,
           meta_reconcile_attempts = 0,
           meta_reconcile_failures = 0,
           meta_connection_generation = ?4,
           meta_operation_id = ?5, meta_operation_kind = 'connect',
           meta_operation_expires_at = unixepoch() + ?6,
           updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
           AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())
           AND EXISTS (
             SELECT 1 FROM users
             JOIN merchant_memberships AS membership
               ON membership.user_id = users.id
             JOIN merchants AS authorized_merchant
               ON authorized_merchant.id = membership.merchant_id
             WHERE users.id = ?12 AND users.status = 'active'
               AND membership.merchant_id = ?2
               AND membership.status = 'active'
               AND membership.role IN ('owner', 'admin')
               AND authorized_merchant.status = 'active'
           )
           AND (
             meta_subscription_status NOT IN ('not_subscribed', 'disconnected')
             OR (
               SELECT COUNT(*) FROM store_pages AS occupied
               WHERE occupied.merchant_id = ?2 AND occupied.id <> ?1
                 AND occupied.meta_subscription_status NOT IN (
                   'not_subscribed', 'disconnected'
                 )
             ) < COALESCE((
               SELECT CASE plan
                 WHEN 'free' THEN 1
                 WHEN 'pro' THEN 3
                 WHEN 'business' THEN 10
                 WHEN 'enterprise' THEN 2147483647
                 ELSE 0 END
               FROM merchants WHERE id = ?2 AND status = 'active'
             ), 0)
           )`,
      ).bind(
        pageId,
        merchantId,
        reserved.meta_connection_generation,
        operationGeneration,
        operationId,
        PAGE_OPERATION_TTL_SECONDS,
        candidate.name,
        candidate.access_token_encrypted,
        JSON.stringify(permissions),
        JSON.stringify(tasks),
        PAGE_RECONCILE_INTERVAL_SECONDS,
        subject,
      ).run();
      if ((acquired.meta.changes ?? 0) !== 1) {
        const diagnosis = await c.env.DB.prepare(
          `SELECT pages.meta_subscription_status, pages.meta_operation_id,
                  pages.meta_operation_expires_at, merchants.plan,
                  EXISTS (
                    SELECT 1 FROM users
                    JOIN merchant_memberships AS membership
                      ON membership.user_id = users.id
                    WHERE users.id = ?3 AND users.status = 'active'
                      AND membership.merchant_id = ?2
                      AND membership.status = 'active'
                      AND membership.role IN ('owner', 'admin')
                      AND merchants.status = 'active'
                  ) AS has_authority,
                  (SELECT COUNT(*) FROM store_pages AS occupied
                   WHERE occupied.merchant_id = ?2 AND occupied.id <> ?1
                     AND occupied.meta_subscription_status NOT IN (
                       'not_subscribed', 'disconnected'
                     )) AS occupied_pages
           FROM store_pages AS pages
           JOIN merchants ON merchants.id = pages.merchant_id
           WHERE pages.id = ?1 AND pages.merchant_id = ?2`,
        ).bind(pageId, merchantId, subject).first<{
          meta_subscription_status: string;
          meta_operation_id: string | null;
          meta_operation_expires_at: number | null;
          plan: string;
          occupied_pages: number;
          has_authority: number;
        }>();
        if (diagnosis?.has_authority !== 1) {
          if ((reservationInsert.meta.changes ?? 0) === 1) {
            await c.env.DB.prepare(
              `DELETE FROM store_pages
               WHERE id = ?1 AND merchant_id = ?2
                 AND meta_subscription_status = 'not_subscribed'
                 AND meta_connection_generation = 0
                 AND meta_operation_id IS NULL`,
            ).bind(pageId, merchantId).run();
          }
          throw new ApiError(
            403,
            'FACEBOOK_APPROVAL_AUTHORITY_LOST',
            'An active owner or admin must approve Facebook Page messaging',
          );
        }
        const alreadyOccupiesSlot = Boolean(
          diagnosis && !['not_subscribed', 'disconnected']
            .includes(diagnosis.meta_subscription_status),
        );
        const operationActive = Boolean(
          diagnosis?.meta_operation_id && diagnosis.meta_operation_expires_at &&
          diagnosis.meta_operation_expires_at >= Math.floor(Date.now() / 1000),
        );
        const planLimitReached = Boolean(
          diagnosis && !operationActive && !alreadyOccupiesSlot &&
          diagnosis.occupied_pages >= facebookPageLimit(diagnosis.plan),
        );
        if (planLimitReached) {
          if ((reservationInsert.meta.changes ?? 0) === 1) {
            await c.env.DB.prepare(
              `DELETE FROM store_pages
               WHERE id = ?1 AND merchant_id = ?2
                 AND meta_subscription_status = 'not_subscribed'
                 AND meta_connection_generation = 0
                 AND meta_operation_id IS NULL`,
            ).bind(pageId, merchantId).run();
          }
          throw new ApiError(
            409,
            'FACEBOOK_PAGE_LIMIT_REACHED',
            'Your current plan has reached its Facebook Page connection limit',
          );
        }
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_OPERATION_IN_PROGRESS',
          'Another Page connection change is already in progress',
        );
      }
      let token: string;
      try {
        token = await decryptSecret(
          candidate.access_token_encrypted,
          encryptionKey(c.env),
        );
      } catch {
        await c.env.DB.prepare(
          `UPDATE store_pages SET
             ai_messaging_enabled = 0,
             messaging_ready_at = NULL,
             meta_subscription_status = 'subscription_failed',
             meta_last_error = 'FACEBOOK_TOKEN_DECRYPT_FAILED',
             meta_subscription_desired = 0,
             meta_reconcile_after = unixepoch() + ?5,
             meta_reconcile_attempts = 0,
             meta_reconcile_failures = 0,
             meta_operation_id = NULL, meta_operation_kind = NULL,
             meta_operation_expires_at = NULL, updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2
             AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
        ).bind(
          pageId,
          merchantId,
          operationGeneration,
          operationId,
          PAGE_RECONCILE_INTERVAL_SECONDS,
        ).run();
        await setSessionResult(
          c.env,
          candidate.session_id,
          'pages_ready',
          'FACEBOOK_TOKEN_DECRYPT_FAILED',
        );
        throw new ApiError(503, 'FACEBOOK_TOKEN_INVALID', 'Stored Facebook token is invalid');
      }
      try {
        await subscribeFacebookPage(c.env, pageId, token);
      } catch (error) {
        const safeCode = error instanceof FacebookGraphError
          ? error.safeCode
          : 'GRAPH_SUBSCRIPTION_FAILED';
        await setSessionResult(
          c.env,
          candidate.session_id,
          'pages_ready',
          safeCode,
        );
        await c.env.DB.prepare(
          `UPDATE store_pages SET
             ai_messaging_enabled = 0,
             messaging_ready_at = NULL,
             meta_subscription_status = 'subscription_failed',
             meta_last_error = 'FACEBOOK_WEBHOOK_SUBSCRIPTION_FAILED',
             meta_subscription_desired = 0,
             meta_reconcile_after = unixepoch() + ?5,
             meta_reconcile_attempts = 0,
             meta_reconcile_failures = 0,
             meta_operation_id = NULL, meta_operation_kind = NULL,
             meta_operation_expires_at = NULL, updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2
             AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
        ).bind(
          pageId,
          merchantId,
          operationGeneration,
          operationId,
          PAGE_RECONCILE_INTERVAL_SECONDS,
        ).run();
        await compensateStaleConnect(
          c.env,
          merchantId,
          pageId,
          token,
          candidate.access_token_encrypted,
        );
        throw new ApiError(
          502,
          'FACEBOOK_WEBHOOK_SUBSCRIPTION_FAILED',
          'Facebook did not accept the Page webhook subscription',
        );
      }
      const approvedAt = enableAiMessaging ? Math.floor(Date.now() / 1000) : null;
      const write = await c.env.DB.prepare(
          `UPDATE store_pages SET
             name = ?5,
             meta_page_access_token = ?6,
             connected_at = unixepoch(),
             meta_subscription_status = 'subscribed',
             meta_permissions_json = ?7,
             meta_tasks_json = ?8,
             messaging_ready_at = unixepoch(),
             ai_messaging_enabled = ?9,
             ai_messaging_approved_at = CASE
               WHEN ?9 = 1 THEN ?10 ELSE ai_messaging_approved_at END,
             ai_messaging_approved_by_user_id = CASE
               WHEN ?9 = 1 THEN ?11 ELSE ai_messaging_approved_by_user_id END,
             ai_messaging_disabled_at = CASE
               WHEN ?9 = 0 THEN unixepoch() ELSE NULL END,
             disconnected_at = NULL,
             meta_last_error = NULL,
             meta_subscription_desired = 1,
             meta_reconcile_after = unixepoch() + ?12,
             meta_reconcile_attempts = 0,
             meta_reconcile_failures = 0,
             meta_operation_id = NULL, meta_operation_kind = NULL,
             meta_operation_expires_at = NULL, updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2
             AND meta_connection_generation = ?3
             AND meta_operation_id = ?4 AND meta_operation_kind = 'connect'
             AND EXISTS (
               SELECT 1 FROM users
               JOIN merchant_memberships AS membership
                 ON membership.user_id = users.id
               JOIN merchants AS authorized_merchant
                 ON authorized_merchant.id = membership.merchant_id
               WHERE users.id = ?13 AND users.status = 'active'
                 AND membership.merchant_id = ?2
                 AND membership.status = 'active'
                 AND membership.role IN ('owner', 'admin')
                 AND authorized_merchant.status = 'active'
             )`,
        ).bind(
          pageId,
          merchantId,
          operationGeneration,
          operationId,
          candidate.name,
          candidate.access_token_encrypted,
          JSON.stringify(permissions),
          JSON.stringify(tasks),
          enableAiMessaging ? 1 : 0,
          approvedAt,
          enableAiMessaging ? subject : null,
          PAGE_RECONCILE_INTERVAL_SECONDS,
          subject,
        ).run();
      if ((write.meta.changes ?? 0) !== 1) {
        const authorityLost = await c.env.DB.prepare(
          `UPDATE store_pages SET
             ai_messaging_enabled = 0,
             ai_messaging_disabled_at = unixepoch(),
             meta_subscription_status = 'subscription_failed',
             messaging_ready_at = NULL,
             meta_subscription_desired = 0,
             meta_reconcile_after = unixepoch() + ?5,
             meta_reconcile_attempts = 0,
             meta_reconcile_failures = 0,
             meta_last_error = 'FACEBOOK_APPROVAL_AUTHORITY_LOST',
             meta_operation_id = NULL, meta_operation_kind = NULL,
             meta_operation_expires_at = NULL, updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2
             AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
        ).bind(
          pageId,
          merchantId,
          operationGeneration,
          operationId,
          PAGE_RECONCILE_INTERVAL_SECONDS,
        ).run();
        await compensateStaleConnect(
          c.env,
          merchantId,
          pageId,
          token,
          candidate.access_token_encrypted,
        );
        if ((authorityLost.meta.changes ?? 0) === 1) {
          await setSessionResult(
            c.env,
            candidate.session_id,
            'pages_ready',
            'FACEBOOK_APPROVAL_AUTHORITY_LOST',
          );
          throw new ApiError(
            403,
            'FACEBOOK_APPROVAL_AUTHORITY_LOST',
            'An active owner or admin must approve Facebook Page messaging',
          );
        }
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_OPERATION_STALE',
          'The Page connection changed while Facebook authorization was completing',
        );
      }
      const connected = await c.env.DB.prepare(
        `SELECT id, name, meta_page_access_token, connected_at,
                meta_subscription_status, meta_permissions_json, meta_tasks_json,
                messaging_ready_at, ai_messaging_enabled,
                ai_messaging_approved_at, ai_messaging_disabled_at,
                disconnected_at, meta_last_error, meta_connection_generation,
                meta_operation_id, meta_operation_kind, meta_operation_expires_at
         FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
      ).bind(pageId, merchantId).first<PageConnectionRow>();
      if (!connected || !pageReady(connected)) {
        throw new ApiError(
          503,
          'FACEBOOK_PAGE_READINESS_NOT_PERSISTED',
          'Facebook Page readiness could not be verified',
        );
      }
      await c.env.DB.batch([
        c.env.DB.prepare(
          'DELETE FROM meta_page_candidates WHERE session_id = ?1',
        ).bind(candidate.session_id),
        c.env.DB.prepare(
          `UPDATE meta_onboarding_sessions
           SET status = 'completed', error_code = NULL, updated_at = unixepoch()
           WHERE id = ?1`,
        ).bind(candidate.session_id),
      ]);
      return jsonOk(c, {
        page: {
          id: pageId,
          name: candidate.name,
          webhookSubscribed: true,
          aiMessagingReady: true,
          aiMessagingEnabled: enableAiMessaging,
          aiMessagingEffective: enableAiMessaging &&
            flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
          aiMessagingApprovedAt: approvedAt,
        },
      });
    },
  )
  .patch(
    '/pages/:pageId/ai',
    requireRole(...MERCHANT_ADMIN_ROLES),
    zValidator('param', pageParamSchema, validationHook),
    zValidator('json', enableSchema, validationHook),
    async (c) => {
      const { merchantId, subject } = c.get('auth');
      const { pageId } = c.req.valid('param');
      const { enabled } = c.req.valid('json');
      const page = await c.env.DB.prepare(
        `SELECT id, name, meta_page_access_token, connected_at,
                meta_subscription_status, meta_permissions_json, meta_tasks_json,
                messaging_ready_at, ai_messaging_enabled,
                ai_messaging_approved_at, ai_messaging_disabled_at,
                disconnected_at, meta_last_error, meta_connection_generation,
                meta_operation_id, meta_operation_kind, meta_operation_expires_at
         FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
      ).bind(pageId, merchantId).first<PageConnectionRow>();
      if (!page) throw new ApiError(404, 'PAGE_NOT_FOUND', 'Page was not found');
      if (enabled && !pageReady(page)) {
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_NOT_READY',
          'Reconnect the Page and complete its webhook subscription before enabling AI messaging',
        );
      }
      const now = Math.floor(Date.now() / 1000);
      const write = await c.env.DB.prepare(
        `UPDATE store_pages SET
           ai_messaging_enabled = ?3,
           ai_messaging_approved_at = CASE WHEN ?3 = 1 THEN ?4 ELSE ai_messaging_approved_at END,
           ai_messaging_approved_by_user_id = CASE
             WHEN ?3 = 1 THEN ?5 ELSE ai_messaging_approved_by_user_id END,
           ai_messaging_disabled_at = CASE WHEN ?3 = 0 THEN ?4 ELSE NULL END,
           meta_connection_generation = meta_connection_generation + 1,
           meta_operation_id = NULL, meta_operation_kind = NULL,
           meta_operation_expires_at = NULL,
           updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2
           AND meta_connection_generation = ?6
           AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())`,
      ).bind(
        pageId,
        merchantId,
        enabled ? 1 : 0,
        now,
        subject,
        page.meta_connection_generation,
      ).run();
      if ((write.meta.changes ?? 0) !== 1) {
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_OPERATION_IN_PROGRESS',
          'Another Page connection change is already in progress',
        );
      }
      return jsonOk(c, {
        id: pageId,
        aiMessagingReady: pageReady(page),
        aiMessagingEnabled: enabled,
        aiMessagingEffective: enabled && pageReady(page) &&
          flag(c.env.AI_ENABLED) && flag(c.env.MESSAGING_ENABLED),
        aiMessagingApprovedAt: enabled ? now : page.ai_messaging_approved_at,
      });
    },
  )
  .delete(
    '/pages/:pageId',
    requireRole(...MERCHANT_ADMIN_ROLES),
    zValidator('param', pageParamSchema, validationHook),
    async (c) => {
      const { merchantId } = c.get('auth');
      const { pageId } = c.req.valid('param');
      const page = await c.env.DB.prepare(
        `SELECT id, name, meta_page_access_token, connected_at,
                meta_subscription_status, meta_permissions_json, meta_tasks_json,
                messaging_ready_at, ai_messaging_enabled,
                ai_messaging_approved_at, ai_messaging_disabled_at,
                disconnected_at, meta_last_error, meta_connection_generation,
                meta_operation_id, meta_operation_kind, meta_operation_expires_at
         FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
      ).bind(pageId, merchantId).first<PageConnectionRow>();
      if (!page) throw new ApiError(404, 'PAGE_NOT_FOUND', 'Page was not found');

      // Stop local sends before attempting the external unsubscribe. On a
      // network failure the encrypted token is retained solely for a retry.
      const operationId = crypto.randomUUID();
      const operationGeneration = page.meta_connection_generation + 1;
      const acquired = await c.env.DB.prepare(
        `UPDATE store_pages SET ai_messaging_enabled = 0,
           ai_messaging_disabled_at = unixepoch(),
           meta_subscription_status = 'disconnecting', messaging_ready_at = NULL,
           meta_subscription_desired = 0,
           meta_reconcile_after = unixepoch() + ?7,
           meta_reconcile_attempts = 0,
           meta_reconcile_failures = 0,
           meta_connection_generation = ?4,
           meta_operation_id = ?5, meta_operation_kind = 'disconnect',
           meta_operation_expires_at = unixepoch() + ?6,
           updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2 AND meta_connection_generation = ?3
           AND (meta_operation_id IS NULL OR meta_operation_expires_at < unixepoch())`,
      ).bind(
        pageId,
        merchantId,
        page.meta_connection_generation,
        operationGeneration,
        operationId,
        PAGE_OPERATION_TTL_SECONDS,
        PAGE_RECONCILE_INTERVAL_SECONDS,
      ).run();
      if ((acquired.meta.changes ?? 0) !== 1) {
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_OPERATION_IN_PROGRESS',
          'Another Page connection change is already in progress',
        );
      }
      if (page.meta_page_access_token) {
        if (!isEncryptedSecret(page.meta_page_access_token)) {
          await c.env.DB.prepare(
            `UPDATE store_pages SET meta_subscription_status = 'unsubscribe_failed',
               meta_last_error = 'FACEBOOK_TOKEN_INVALID',
               meta_operation_id = NULL, meta_operation_kind = NULL,
               meta_operation_expires_at = NULL, updated_at = unixepoch()
             WHERE id = ?1 AND merchant_id = ?2
               AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
          ).bind(pageId, merchantId, operationGeneration, operationId).run();
          throw new ApiError(503, 'FACEBOOK_TOKEN_INVALID', 'Stored Facebook token is invalid');
        }
        let token: string;
        try {
          token = await decryptSecret(page.meta_page_access_token, encryptionKey(c.env));
        } catch {
          await c.env.DB.prepare(
            `UPDATE store_pages SET meta_subscription_status = 'unsubscribe_failed',
               meta_last_error = 'FACEBOOK_TOKEN_DECRYPT_FAILED',
               meta_operation_id = NULL, meta_operation_kind = NULL,
               meta_operation_expires_at = NULL, updated_at = unixepoch()
             WHERE id = ?1 AND merchant_id = ?2
               AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
          ).bind(pageId, merchantId, operationGeneration, operationId).run();
          throw new ApiError(503, 'FACEBOOK_TOKEN_INVALID', 'Stored Facebook token is invalid');
        }
        try {
          await unsubscribeFacebookPage(c.env, pageId, token);
        } catch {
          const failed = await c.env.DB.prepare(
            `UPDATE store_pages SET meta_subscription_status = 'unsubscribe_failed',
               messaging_ready_at = NULL,
               meta_last_error = 'FACEBOOK_UNSUBSCRIBE_FAILED',
               meta_operation_id = NULL, meta_operation_kind = NULL,
               meta_operation_expires_at = NULL, updated_at = unixepoch()
             WHERE id = ?1 AND merchant_id = ?2
               AND meta_connection_generation = ?3 AND meta_operation_id = ?4`,
          ).bind(pageId, merchantId, operationGeneration, operationId).run();
          if ((failed.meta.changes ?? 0) !== 1) {
            await compensateStaleDisconnect(c.env, merchantId, pageId);
          }
          throw new ApiError(
            502,
            'FACEBOOK_UNSUBSCRIBE_FAILED',
            'AI messaging is disabled, but Facebook webhook removal must be retried',
          );
        }
      }
      const completed = await c.env.DB.prepare(
        `UPDATE store_pages SET
           meta_subscription_status = 'disconnected', messaging_ready_at = NULL,
           ai_messaging_enabled = 0, connected_at = NULL,
           disconnected_at = unixepoch(), meta_last_error = NULL,
           meta_reconcile_after = CASE
             WHEN meta_page_access_token IS NULL THEN NULL
             ELSE meta_reconcile_after END,
           meta_operation_id = NULL, meta_operation_kind = NULL,
           meta_operation_expires_at = NULL,
           updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2
           AND meta_connection_generation = ?3 AND meta_operation_id = ?4
           AND meta_operation_kind = 'disconnect'`,
      ).bind(pageId, merchantId, operationGeneration, operationId).run();
      if ((completed.meta.changes ?? 0) !== 1) {
        await compensateStaleDisconnect(c.env, merchantId, pageId);
        throw new ApiError(
          409,
          'FACEBOOK_PAGE_OPERATION_STALE',
          'The Page connection changed while disconnecting',
        );
      }
      return jsonOk(c, { id: pageId, disconnected: true, aiMessagingEnabled: false });
    },
  );
