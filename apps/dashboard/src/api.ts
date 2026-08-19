import { hc } from 'hono/client';
import type { AppType } from '@inboxplease/api/app';
import { demoData } from './data';
import type { DashboardData } from './types';

const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
export const AUTH_URL = API_URL.startsWith('http')
  ? API_URL.replace(/\/api$/, '')
  : window.location.origin;
const RPC_BASE_URL = API_URL.startsWith('http')
  ? API_URL.replace(/\/api$/, '')
  : window.location.origin;
const rpc = hc<AppType>(RPC_BASE_URL);
export const SESSION_TOKEN_STORAGE_KEY = 'inboxplease.session-token';

/**
 * The first-party sign-in flow stores its short-lived dashboard token here.
 * sessionStorage keeps it out of URLs and production bundles and clears it
 * when the browser tab closes.
 */
export function getSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  const normalized = token.trim();
  if (!normalized) throw new Error('A non-empty session token is required');
  window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, normalized);
}

export function clearSessionToken(): void {
  window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
}

interface DashboardSummary {
  catalog: { total: number; active: number; outOfStock: number };
  orders: { total: number; open: number };
  paidRevenue: Array<{ amountMinor: number; currency: string }>;
  usage: Array<{ month: string; aiMessages: number; visionMessages: number }>;
  platform: { aiEnabled: boolean; messagingEnabled: boolean; aiMessagingAvailable: boolean };
  pages: Array<{
    id: string;
    name: string;
    connectedAt: number | null;
    webhookSubscribed: boolean;
    aiMessagingReady: boolean;
    aiMessagingEnabled: boolean;
    aiMessagingEffective: boolean;
  }>;
}

interface AccountSummary {
  user: { id: string; name: string; email: string | null };
  merchant: { id: string; name: string; plan: string };
  role: 'owner' | 'admin' | 'staff' | 'service';
}

interface ApiEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

function isDashboardSummary(value: unknown): value is DashboardSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<DashboardSummary>;
  return Boolean(
    summary.catalog && typeof summary.catalog.total === 'number' &&
    summary.orders && typeof summary.orders.total === 'number' &&
    Array.isArray(summary.paidRevenue) && Array.isArray(summary.usage) &&
    summary.platform && typeof summary.platform.aiMessagingAvailable === 'boolean' &&
    Array.isArray(summary.pages) && summary.pages.every((page) =>
      typeof page.aiMessagingReady === 'boolean' &&
      typeof page.aiMessagingEnabled === 'boolean' &&
      typeof page.aiMessagingEffective === 'boolean'),
  );
}

function isAccountSummary(value: unknown): value is AccountSummary {
  if (!value || typeof value !== 'object') return false;
  const account = value as Partial<AccountSummary>;
  return Boolean(
    account.user && typeof account.user.name === 'string' &&
    account.merchant && typeof account.merchant.name === 'string' &&
    typeof account.merchant.plan === 'string' &&
    account.role && ['owner', 'admin', 'staff', 'service'].includes(account.role),
  );
}

function dashboardPlan(plan: string): DashboardData['merchant']['plan'] {
  const normalized = plan.trim().toLowerCase();
  if (normalized === 'enterprise') return 'Enterprise';
  if (normalized === 'business') return 'Business';
  if (normalized === 'pro') return 'Pro';
  return 'Free';
}

function mergeSummary(summary: DashboardSummary, account: AccountSummary): DashboardData {
  const currentUsage = summary.usage[0];
  const bdtRevenueMinor = summary.paidRevenue
    .filter((item) => item.currency === 'BDT')
    .reduce((total, item) => total + item.amountMinor, 0);
  const metrics = demoData.metrics.map((metric) => {
    if (metric.id === 'revenue') {
      return {
        ...metric,
        value: `৳${new Intl.NumberFormat('en-BD').format(Math.round(bdtRevenueMinor / 100))}`,
        helper: 'all paid orders',
      };
    }
    if (metric.id === 'orders') {
      return { ...metric, value: String(summary.orders.total), helper: `${summary.orders.open} open` };
    }
    if (metric.id === 'conversations' && currentUsage) {
      return { ...metric, value: String(currentUsage.aiMessages), helper: currentUsage.month };
    }
    return metric;
  });

  return {
    ...demoData,
    merchant: {
      name: account.user.name,
      storeName: account.merchant.name,
      plan: dashboardPlan(account.merchant.plan),
      role: account.role,
    },
    metrics,
    usage: {
      ...demoData.usage,
      messagesUsed: currentUsage?.aiMessages ?? 0,
      productsUsed: summary.catalog.total,
      pagesUsed: summary.pages.length,
      imageMatches: currentUsage?.visionMessages ?? 0,
    },
    pages: summary.pages.map((page) => ({
      id: page.id,
      name: page.name,
      handle: `Page ID ${page.id}`,
      status: page.aiMessagingEffective ? 'connected' : 'attention',
      followers: '—',
      responseRate: '—',
      lastSynced: page.aiMessagingEffective
        ? 'AI messaging active'
        : page.aiMessagingEnabled && !summary.platform.aiMessagingAvailable
          ? 'Approved · platform paused'
          : page.aiMessagingReady
            ? 'Seller approval needed'
            : 'Needs attention',
      messagingReady: page.aiMessagingReady,
      aiMessagingEnabled: page.aiMessagingEnabled,
      aiMessagingEffective: page.aiMessagingEffective,
    })),
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function apiErrorDetails(payload: unknown, status: number): { message: string; code?: string } {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      const code = (error as { code?: unknown }).code;
      const normalizedCode = typeof code === 'string' && code.trim() ? code.trim() : undefined;
      if (typeof message === 'string' && message.trim()) {
        return {
          message: message.trim(),
          ...(normalizedCode ? { code: normalizedCode } : {}),
        };
      }
      if (normalizedCode) return { message: `Request failed with ${status}`, code: normalizedCode };
    }
  }
  return { message: `Request failed with ${status}` };
}

function responseError(status: number, payload: unknown): ApiError {
  const details = apiErrorDetails(payload, status);
  return new ApiError(details.message, status, payload, details.code);
}

function sessionHeaders(): Record<string, string> {
  const token = getSessionToken();
  // Auth.js uses an HttpOnly cookie, which JavaScript intentionally cannot
  // inspect. When no bearer token is present, let the API authenticate that
  // cookie (or return its normal 401) instead of rejecting in the browser.
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function clearDashboardSession(): Promise<void> {
  clearSessionToken();
  try {
    const csrfResponse = await fetch(`${RPC_BASE_URL}/authjs/csrf`, {
      credentials: 'include',
    });
    if (!csrfResponse.ok) return;
    const payload = await csrfResponse.json() as { csrfToken?: unknown };
    if (typeof payload.csrfToken !== 'string' || !payload.csrfToken) return;
    await fetch(`${RPC_BASE_URL}/authjs/signout`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrfToken: payload.csrfToken,
        callbackUrl: `${window.location.origin}/signin`,
      }),
    });
  } catch {
    // Local bearer state is already cleared. A network failure must not trap
    // the user in the dashboard; the server cookie can expire independently.
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown };

export const api = {
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(sessionHeaders())) headers.set(name, value);
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      credentials: options.credentials ?? 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const payload = await response.json().catch(() => undefined) as T | undefined;
    if (!response.ok || payload === undefined) {
      throw responseError(response.status, payload);
    }
    return payload as T;
  },
  get<T>(path: string) {
    return this.request<T>(path);
  },
  post<TResponse, TBody>(path: string, body: TBody) {
    return this.request<TResponse>(path, { method: 'POST', body });
  },
  put<TResponse, TBody>(path: string, body: TBody) {
    return this.request<TResponse>(path, { method: 'PUT', body });
  },
  patch<TResponse, TBody>(path: string, body: TBody) {
    return this.request<TResponse>(path, { method: 'PATCH', body });
  },
  delete<TResponse>(path: string) {
    return this.request<TResponse>(path, { method: 'DELETE' });
  },
};

export function mediaAssetUrl(assetId: string): string {
  return `${API_URL}/media/${encodeURIComponent(assetId)}`;
}

export async function uploadProductImage(
  productId: string,
  file: File,
  variantId?: string,
): Promise<void> {
  const query = new URLSearchParams({ role: 'primary' });
  if (variantId) query.set('variantId', variantId);
  const response = await fetch(
    `${API_URL}/media/products/${encodeURIComponent(productId)}?${query}`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: {
        ...sessionHeaders(),
        'Content-Type': file.type,
      },
      body: file,
    },
  );
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw responseError(response.status, payload);
}

export async function getDashboardData(): Promise<{ data: DashboardData; source: 'api' | 'demo' }> {
  try {
    const headers = sessionHeaders();
    const [response, accountResponse] = await Promise.all([
      rpc.api.dashboard.$get({}, { headers, init: { credentials: 'include' } }),
      rpc.api.account.me.$get({}, { headers, init: { credentials: 'include' } }),
    ]);
    const [payload, accountPayload] = await Promise.all([
      (response.json() as Promise<unknown>).catch(() => undefined),
      (accountResponse.json() as Promise<unknown>).catch(() => undefined),
    ]);
    if (!response.ok) throw responseError(response.status, payload);
    if (!accountResponse.ok) {
      throw responseError(accountResponse.status, accountPayload);
    }
    const envelope = payload as Partial<ApiEnvelope<unknown>>;
    const accountEnvelope = accountPayload as Partial<ApiEnvelope<unknown>>;
    if (
      envelope.ok !== true || !isDashboardSummary(envelope.data) ||
      accountEnvelope.ok !== true || !isAccountSummary(accountEnvelope.data)
    ) {
      throw new ApiError('Dashboard API returned an unexpected response', 502, payload);
    }
    return { data: mergeSummary(envelope.data, accountEnvelope.data), source: 'api' };
  } catch (error) {
    // Demo data is a development-server affordance, never a production
    // authentication or availability fallback.
    if (!import.meta.env.DEV) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 320));
    return { data: demoData, source: 'demo' };
  }
}
