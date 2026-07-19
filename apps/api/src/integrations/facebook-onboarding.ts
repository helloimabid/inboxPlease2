import type { Bindings } from '../env';
import { ApiError } from '../errors';
import { hmacSha256Hex, utf8 } from '../security';
import { facebookMessagingCredentials } from './facebook-config';

export const FACEBOOK_PAGE_PERMISSIONS = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
] as const;

export const FACEBOOK_MESSAGING_PAGE_TASKS = [
  'MESSAGING',
  'MESSAGE',
  'PROFILE_PLUS_MESSAGING',
  'PROFILE_PLUS_FULL_CONTROL',
] as const;

export function hasFacebookMessagingTask(tasks: readonly string[]): boolean {
  const present = new Set(tasks);
  return FACEBOOK_MESSAGING_PAGE_TASKS.some((task) => present.has(task));
}

export const FACEBOOK_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'message_reads',
  'messaging_handovers',
] as const;

type GraphRecord = Record<string, unknown>;

export class FacebookGraphError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;
  readonly graphCode?: number;

  constructor(safeCode: string, retryable = false, graphCode?: number) {
    super('Facebook Graph request failed');
    this.name = 'FacebookGraphError';
    this.safeCode = safeCode;
    this.retryable = retryable;
    if (graphCode !== undefined) {
      this.graphCode = graphCode;
    }
  }
}

function graphVersion(env: Bindings): string {
  const configured = env.META_GRAPH_VERSION ?? 'v21.0';
  if (!/^v\d+\.\d+$/.test(configured)) {
    throw new ApiError(503, 'FACEBOOK_NOT_CONFIGURED', 'Facebook Graph version is invalid');
  }
  return configured;
}

export function facebookCallbackUrl(env: Bindings): string {
  const base = env.PUBLIC_API_BASE_URL;
  if (!base) {
    throw new ApiError(
      503,
      'FACEBOOK_NOT_CONFIGURED',
      'The public API URL is not configured',
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ApiError(503, 'FACEBOOK_NOT_CONFIGURED', 'The public API URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiError(503, 'FACEBOOK_NOT_CONFIGURED', 'The public API URL is invalid');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/facebook/callback`;
  return url.toString();
}

export function facebookAuthorizationUrl(env: Bindings, state: string): string {
  const { appId } = facebookMessagingCredentials(env);
  const url = new URL(
    `https://www.facebook.com/${graphVersion(env)}/dialog/oauth`,
  );
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', facebookCallbackUrl(env));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', FACEBOOK_PAGE_PERMISSIONS.join(','));
  url.searchParams.set('auth_type', 'rerequest');
  url.searchParams.set('return_scopes', 'true');
  return url.toString();
}

function graphUrl(env: Bindings, path: string): URL {
  return new URL(`https://graph.facebook.com/${graphVersion(env)}/${path}`);
}

async function responseRecord(response: Response): Promise<GraphRecord> {
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new FacebookGraphError(`GRAPH_${response.status || 'INVALID'}_RESPONSE`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new FacebookGraphError(
      `GRAPH_${response.status || 'INVALID'}_RESPONSE`,
      response.status === 429 || response.status >= 500,
    );
  }
  if (!response.ok) {
    const graphError = (result as GraphRecord).error;
    const error = graphError && typeof graphError === 'object' && !Array.isArray(graphError)
      ? graphError as GraphRecord
      : {};
    const graphCode = typeof error.code === 'number' && Number.isSafeInteger(error.code)
      ? error.code
      : undefined;
    const transientCodes = new Set([1, 2, 4, 17, 32, 341, 613]);
    const retryable = error.is_transient === true || response.status === 429 ||
      response.status >= 500 || (graphCode !== undefined && transientCodes.has(graphCode));
    throw new FacebookGraphError(
      `GRAPH_${response.status || 'INVALID'}_RESPONSE`,
      retryable,
      graphCode,
    );
  }
  return result as GraphRecord;
}

async function appSecretProof(appSecret: string, accessToken: string): Promise<string> {
  return hmacSha256Hex(appSecret, utf8(accessToken));
}

async function graphGet(
  env: Bindings,
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
): Promise<GraphRecord> {
  const { appSecret } = facebookMessagingCredentials(env);
  const url = graphUrl(env, path);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('appsecret_proof', await appSecretProof(appSecret, accessToken));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new FacebookGraphError('GRAPH_NETWORK_ERROR', true);
  }
  return responseRecord(response);
}

async function exchangeToken(
  env: Bindings,
  body: URLSearchParams,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(graphUrl(env, 'oauth/access_token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new FacebookGraphError('GRAPH_NETWORK_ERROR', true);
  }
  const payload = await responseRecord(response);
  const token = payload.access_token;
  if (typeof token !== 'string' || token.length < 16 || token.length > 4_096) {
    throw new FacebookGraphError('GRAPH_INVALID_ACCESS_TOKEN');
  }
  return token;
}

/** Exchange the callback code and then promote it to a long-lived user token. */
export async function exchangeFacebookCode(env: Bindings, code: string): Promise<string> {
  const { appId, appSecret } = facebookMessagingCredentials(env);
  if (!code || code.length > 4_096) throw new FacebookGraphError('GRAPH_INVALID_CODE');
  const shortLivedToken = await exchangeToken(env, new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: facebookCallbackUrl(env),
    code,
  }));
  return exchangeToken(env, new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  }));
}

export async function facebookUserId(
  env: Bindings,
  userAccessToken: string,
): Promise<string> {
  const payload = await graphGet(env, 'me', userAccessToken, { fields: 'id' });
  const id = payload.id;
  if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) {
    throw new FacebookGraphError('GRAPH_INVALID_USER');
  }
  return id;
}

export async function facebookGrantedPermissions(
  env: Bindings,
  userAccessToken: string,
): Promise<string[]> {
  const payload = await graphGet(env, 'me/permissions', userAccessToken);
  if (!Array.isArray(payload.data)) throw new FacebookGraphError('GRAPH_INVALID_PERMISSIONS');
  const granted = payload.data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as GraphRecord;
    return row.status === 'granted' && typeof row.permission === 'string'
      ? [row.permission]
      : [];
  });
  return [...new Set(granted)].sort();
}

export interface FacebookPageCandidate {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
}

export async function facebookPages(
  env: Bindings,
  userAccessToken: string,
): Promise<FacebookPageCandidate[]> {
  const payload = await graphGet(env, 'me/accounts', userAccessToken, {
    fields: 'id,name,access_token,tasks',
    limit: '100',
  });
  if (!Array.isArray(payload.data)) throw new FacebookGraphError('GRAPH_INVALID_PAGES');
  return payload.data.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as GraphRecord;
    if (
      typeof row.id !== 'string' || !/^\d{1,32}$/.test(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 ||
      typeof row.access_token !== 'string' || row.access_token.length < 16 ||
      row.access_token.length > 4_096 || !Array.isArray(row.tasks)
    ) return [];
    const tasks = [...new Set(row.tasks.filter(
      (task): task is string => typeof task === 'string' && task.length <= 100,
    ))].sort();
    return [{
      id: row.id,
      name: row.name.trim(),
      accessToken: row.access_token,
      tasks,
    }];
  });
}

async function pageSubscriptionRequest(
  env: Bindings,
  pageId: string,
  pageAccessToken: string,
  method: 'POST' | 'DELETE',
): Promise<void> {
  if (!/^\d{1,32}$/.test(pageId)) throw new FacebookGraphError('GRAPH_INVALID_PAGE');
  const { appSecret } = facebookMessagingCredentials(env);
  const url = graphUrl(env, `${encodeURIComponent(pageId)}/subscribed_apps`);
  url.searchParams.set('appsecret_proof', await appSecretProof(appSecret, pageAccessToken));
  const body = method === 'POST'
    ? new URLSearchParams({ subscribed_fields: FACEBOOK_WEBHOOK_FIELDS.join(',') })
    : undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${pageAccessToken}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new FacebookGraphError('GRAPH_NETWORK_ERROR', true);
  }
  const payload = await responseRecord(response);
  if (payload.success !== true) throw new FacebookGraphError('GRAPH_SUBSCRIPTION_REJECTED');
}

export function subscribeFacebookPage(
  env: Bindings,
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  return pageSubscriptionRequest(env, pageId, pageAccessToken, 'POST');
}

export function unsubscribeFacebookPage(
  env: Bindings,
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  return pageSubscriptionRequest(env, pageId, pageAccessToken, 'DELETE');
}
