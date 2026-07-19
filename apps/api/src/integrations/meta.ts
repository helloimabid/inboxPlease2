import { flag, isDevelopment } from '../config';
import type { Bindings, MetaMessagingEvent, MetaWebhookPayload } from '../env';
import { stableEventId } from '../db';
import { BodyTooLargeError, readBodyBounded } from '../bounded-body';
import { decryptSecret, isEncryptedSecret } from '../secret-envelope';
import {
  FACEBOOK_PAGE_PERMISSIONS,
  hasFacebookMessagingTask,
} from './facebook-onboarding';

export function isActionableMetaEvent(event: MetaMessagingEvent): boolean {
  if (event.message?.is_echo) return false;
  if (event.delivery || event.read) return false;
  return Boolean(
    event.message || event.postback || event.pass_thread_control ||
    event.take_thread_control || event.request_thread_control,
  );
}

export function isMetaHandoverEvent(event: MetaMessagingEvent): boolean {
  return Boolean(
    event.pass_thread_control || event.take_thread_control || event.request_thread_control,
  );
}

export async function metaPayloadEventId(payload: MetaWebhookPayload): Promise<string> {
  const fingerprints: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      fingerprints.push([
        entry.id ?? '',
        event.sender?.id ?? '',
        event.recipient?.id ?? '',
        event.message?.mid ?? event.postback?.mid ?? '',
        String(event.timestamp ?? entry.time ?? ''),
      ].join(':'));
    }
  }
  return stableEventId(['meta', ...fingerprints.sort(), JSON.stringify(payload).slice(0, 512)]);
}

export interface PageMessagingCredential {
  meta_page_access_token: string | null;
  meta_subscription_status: string;
  meta_permissions_json: string;
  meta_tasks_json: string;
  messaging_ready_at: number | null;
  ai_messaging_enabled: number;
}

function serializedStrings(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function containsAll(serialized: string, required: readonly string[]): boolean {
  const values = new Set(serializedStrings(serialized));
  return required.every((value) => values.has(value));
}

export function isPageCredentialReady(row: PageMessagingCredential | null): boolean {
  return Boolean(
    row && row.messaging_ready_at &&
    row.meta_subscription_status === 'subscribed' &&
    row.meta_page_access_token && isEncryptedSecret(row.meta_page_access_token) &&
    containsAll(row.meta_permissions_json, FACEBOOK_PAGE_PERMISSIONS) &&
    hasFacebookMessagingTask(serializedStrings(row.meta_tasks_json)),
  );
}

export function isReadyPageCredential(row: PageMessagingCredential | null): boolean {
  return Boolean(row?.ai_messaging_enabled === 1 && isPageCredentialReady(row));
}

async function pageCredential(
  env: Bindings,
  merchantId: string,
  pageId: string,
): Promise<PageMessagingCredential | null> {
  return env.DB.prepare(
    `SELECT pages.meta_page_access_token, pages.meta_subscription_status,
            pages.meta_permissions_json, pages.meta_tasks_json,
            pages.messaging_ready_at, pages.ai_messaging_enabled
     FROM store_pages AS pages
     JOIN merchants ON merchants.id = pages.merchant_id
     WHERE pages.id = ?1 AND pages.merchant_id = ?2
       AND merchants.status = 'active'`,
  ).bind(pageId, merchantId).first<PageMessagingCredential>();
}

export async function isPageAiMessagingEnabled(
  env: Bindings,
  merchantId: string,
  pageId: string,
): Promise<boolean> {
  return isReadyPageCredential(await pageCredential(env, merchantId, pageId));
}

export async function isPageAiAutomationActive(
  env: Bindings,
  merchantId: string,
  pageId: string,
): Promise<boolean> {
  return flag(env.AI_ENABLED) && flag(env.MESSAGING_ENABLED) &&
    isPageAiMessagingEnabled(env, merchantId, pageId);
}

async function pageToken(
  env: Bindings,
  merchantId: string,
  pageId: string,
  requireAiApproval = false,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT meta_page_access_token, meta_subscription_status,
            meta_permissions_json, meta_tasks_json, messaging_ready_at,
            ai_messaging_enabled
     FROM store_pages AS pages
     JOIN merchants ON merchants.id = pages.merchant_id
     WHERE pages.id = ?1 AND pages.merchant_id = ?2
       AND merchants.status = 'active'`,
  ).bind(pageId, merchantId).first<PageMessagingCredential>();
  if (requireAiApproval && !isReadyPageCredential(row)) return null;
  if (row?.meta_page_access_token) {
    if (isEncryptedSecret(row.meta_page_access_token)) {
      if (!env.META_TOKEN_ENCRYPTION_KEY) {
        throw new Error('Meta token encryption key is not configured');
      }
      return decryptSecret(row.meta_page_access_token, env.META_TOKEN_ENCRYPTION_KEY);
    }
    // Existing plaintext rows are usable only in the explicit local profile.
    // Production multi-tenant credentials must be AES-GCM envelopes.
    if (isDevelopment(env)) return row.meta_page_access_token;
    throw new Error(`Meta access token for page ${pageId} is not encrypted`);
  }
  throw new Error(`No Meta access token for page ${pageId}`);
}

function graphUrl(env: Bindings, path: string): string {
  const version = env.META_GRAPH_VERSION ?? 'v21.0';
  return `https://graph.facebook.com/${encodeURIComponent(version)}/${path}`;
}

async function graphPost(
  env: Bindings,
  merchantId: string,
  pageId: string,
  path: string,
  body: unknown,
  requireAiApproval = false,
): Promise<boolean> {
  const token = await pageToken(env, merchantId, pageId, requireAiApproval);
  if (!token) return false;
  const response = await fetch(graphUrl(env, path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const failure = await safeMetaGraphFailure(response);
    if (failure.credentialRejected) {
      await failCloseRejectedPage(env, merchantId, pageId);
    }
    throw new Error(`Meta Graph request failed: ${failure.safeCode}`);
  }
  return true;
}

export async function sendAiReply(
  env: Bindings,
  merchantId: string,
  pageId: string,
  customerPsid: string,
  text: string,
): Promise<boolean> {
  if (!(await isPageAiAutomationActive(env, merchantId, pageId))) return false;
  // AI replies always use RESPONSE. HUMAN_AGENT is reserved for actual human agents.
  return graphPost(env, merchantId, pageId, `${encodeURIComponent(pageId)}/messages`, {
    recipient: { id: customerPsid },
    messaging_type: 'RESPONSE',
    message: { text: text.slice(0, 2_000) },
  }, true);
}

export async function sendProactiveOrderUpdate(
  env: Bindings,
  merchantId: string,
  pageId: string,
  customerPsid: string,
  text: string,
): Promise<boolean> {
  // There is not yet a persisted, tenant-scoped record of customer opt-in,
  // Meta entitlement, message category, or allowed delivery window. Keep this
  // path technically hard-off even if a variable is toggled accidentally.
  // Ordinary customer replies continue through sendAiReply after Page approval.
  const proactivePolicyEnforcementImplemented = false;
  if (!proactivePolicyEnforcementImplemented) return false;
  if (!flag(env.MESSAGING_ENABLED) || !flag(env.PROACTIVE_ORDER_UPDATES_ENABLED)) {
    return false;
  }
  return graphPost(env, merchantId, pageId, `${encodeURIComponent(pageId)}/messages`, {
    recipient: { id: customerPsid },
    // Utility delivery is separately feature-gated because the Page must have
    // current Meta utility-message eligibility and customer opt-in.
    messaging_type: 'UTILITY',
    message: { text: text.slice(0, 2_000) },
  }, true);
}

export async function passThreadToHuman(
  env: Bindings,
  merchantId: string,
  pageId: string,
  customerPsid: string,
  metadata: string,
): Promise<boolean> {
  const targetAppId = env.META_HANDOVER_TARGET_APP_ID;
  if (!flag(env.MESSAGING_ENABLED) || !flag(env.HANDOFF_ON_COMPLAINT) || !targetAppId) {
    return false;
  }
  return graphPost(env, merchantId, pageId, `${encodeURIComponent(pageId)}/pass_thread_control`, {
    recipient: { id: customerPsid },
    target_app_id: targetAppId,
    metadata: metadata.slice(0, 1_000),
  }, true);
}

const META_MEDIA_HOSTS = ['facebook.com', 'fbcdn.net', 'fbsbx.com'] as const;
const MAX_META_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_META_ERROR_BYTES = 32 * 1024;
const META_FETCH_TIMEOUT_MS = 15_000;

async function safeMetaGraphFailure(response: Response): Promise<{
  safeCode: string;
  credentialRejected: boolean;
}> {
  let code: number | undefined;
  let transient = false;
  try {
    const body = await readBodyBounded(
      response.body,
      MAX_META_ERROR_BYTES,
      Number(response.headers.get('Content-Length') ?? 0),
    );
    const payload = JSON.parse(new TextDecoder().decode(body)) as {
      error?: { code?: unknown; is_transient?: unknown };
    };
    if (typeof payload.error?.code === 'number' && Number.isSafeInteger(payload.error.code)) {
      code = payload.error.code;
    }
    transient = payload.error?.is_transient === true;
  } catch {
    // Never surface or persist Meta's raw error body.
  }
  const credentialRejected = !transient && (
    response.status === 401 || response.status === 403 ||
    code === 10 || code === 190 || code === 200
  );
  return {
    safeCode: credentialRejected
      ? 'FACEBOOK_PAGE_CREDENTIAL_REJECTED'
      : `META_GRAPH_HTTP_${response.status || 'INVALID'}`,
    credentialRejected,
  };
}

async function failCloseRejectedPage(
  env: Bindings,
  merchantId: string,
  pageId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE store_pages SET ai_messaging_enabled = 0,
       ai_messaging_disabled_at = unixepoch(),
       meta_subscription_status = 'subscription_failed',
       messaging_ready_at = NULL,
       meta_last_error = 'FACEBOOK_PAGE_CREDENTIAL_REJECTED',
       meta_reconcile_after = NULL,
       meta_reconcile_attempts = 0,
       meta_reconcile_failures = meta_reconcile_failures + 1,
       meta_connection_generation = meta_connection_generation + 1,
       meta_operation_id = NULL, meta_operation_kind = NULL,
       meta_operation_expires_at = NULL,
       updated_at = unixepoch()
     WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(pageId, merchantId).run();
}

export function validatedMetaMediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Meta media URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const trustedHost = META_MEDIA_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (url.protocol !== 'https:' || !trustedHost || url.username || url.password) {
    throw new Error('Meta media URL is not a trusted HTTPS endpoint');
  }
  return url;
}

export async function fetchMetaMedia(
  env: Bindings,
  merchantId: string,
  pageId: string,
  url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const token = await pageToken(env, merchantId, pageId);
  if (!token) throw new Error(`No Meta access token for page ${pageId}`);
  const trustedUrl = validatedMetaMediaUrl(url);
  const response = await fetch(trustedUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Unable to fetch Meta media: ${response.status}`);
  let bytes: ArrayBuffer;
  try {
    bytes = await readBodyBounded(
      response.body,
      MAX_META_MEDIA_BYTES,
      Number(response.headers.get('Content-Length') ?? 0),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new Error('Meta media exceeds 25 MiB limit');
    throw error;
  }
  return {
    bytes,
    contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
  };
}
