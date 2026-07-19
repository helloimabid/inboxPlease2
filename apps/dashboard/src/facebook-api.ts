import { api } from './api';

interface ApiEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

export interface FacebookPageCandidate {
  id: string;
  name: string;
  tasks: string[];
  eligible: boolean;
  missingTasks: string[];
}

export interface FacebookPageConnection {
  id: string;
  name: string;
  connectedAt: number | null;
  webhookSubscribed: boolean;
  aiMessagingReady: boolean;
  aiMessagingEnabled: boolean;
  aiMessagingEffective: boolean;
  lastError: string | null;
}

export interface FacebookConnectionState {
  status: string;
  requiredPermissions: string[];
  grantedPermissions: string[];
  allPermissionsGranted: boolean;
  authorizationExpiresAt: number | null;
  lastError: string | null;
  platform: {
    aiEnabled: boolean;
    messagingEnabled: boolean;
    aiMessagingAvailable: boolean;
  };
  candidates: FacebookPageCandidate[];
  pages: FacebookPageConnection[];
}

interface FacebookAuthorization {
  authorizationUrl: string;
  expiresAt: number;
}

function unwrap<T>(response: ApiEnvelope<T>): T {
  if (!response || response.ok !== true || !response.data) {
    throw new Error('Facebook setup returned an unexpected response.');
  }
  return response.data;
}

export async function getFacebookConnection(): Promise<FacebookConnectionState> {
  return unwrap(await api.get<ApiEnvelope<FacebookConnectionState>>('/facebook/connection'));
}

export async function beginFacebookConnection(): Promise<void> {
  const authorization = unwrap(await api.post<ApiEnvelope<FacebookAuthorization>, Record<string, never>>('/facebook/connect', {}));
  const target = new URL(authorization.authorizationUrl);
  if (target.protocol !== 'https:' || (target.hostname !== 'facebook.com' && !target.hostname.endsWith('.facebook.com'))) {
    throw new Error('InboxPlease returned an invalid Facebook authorization address.');
  }
  window.location.assign(target.toString());
}

export async function approveFacebookPage(pageId: string): Promise<void> {
  unwrap(await api.post<ApiEnvelope<{ page: FacebookPageConnection }>, { enableAiMessaging: true }>(
    `/facebook/pages/${encodeURIComponent(pageId)}/approve`,
    { enableAiMessaging: true },
  ));
}

export async function setFacebookAiMessaging(pageId: string, enabled: boolean): Promise<void> {
  unwrap(await api.patch<ApiEnvelope<Pick<FacebookPageConnection, 'id' | 'aiMessagingReady' | 'aiMessagingEnabled'>>, { enabled: boolean }>(
    `/facebook/pages/${encodeURIComponent(pageId)}/ai`,
    { enabled },
  ));
}

export async function disconnectFacebookPage(pageId: string): Promise<void> {
  unwrap(await api.request<ApiEnvelope<{ id: string; disconnected: true; aiMessagingEnabled: false }>>(
    `/facebook/pages/${encodeURIComponent(pageId)}`,
    { method: 'DELETE' },
  ));
}
