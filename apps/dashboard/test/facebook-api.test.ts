import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../src/api', () => ({ api: apiMock }));

import {
  approveFacebookPage,
  beginFacebookConnection,
  disconnectFacebookPage,
  getFacebookConnection,
  setFacebookAiMessaging,
} from '../src/facebook-api';

function envelope<T>(data: T) {
  return { ok: true as const, data, requestId: 'request-id' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Facebook Page approval client contract', () => {
  it('loads connection state from the protected Facebook endpoint', async () => {
    const state = {
      status: 'ready',
      requiredPermissions: ['pages_show_list', 'pages_manage_metadata', 'pages_messaging'],
      grantedPermissions: ['pages_show_list', 'pages_manage_metadata', 'pages_messaging'],
      allPermissionsGranted: true,
      authorizationExpiresAt: 123,
      lastError: null,
      platform: { aiEnabled: false, messagingEnabled: false, aiMessagingAvailable: false },
      candidates: [],
      pages: [],
    };
    apiMock.get.mockResolvedValue(envelope(state));

    await expect(getFacebookConnection()).resolves.toBe(state);
    expect(apiMock.get).toHaveBeenCalledWith('/facebook/connection');
  });

  it('starts only an HTTPS facebook.com authorization returned by the API', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    apiMock.post.mockResolvedValue(envelope({
      authorizationUrl: 'https://www.facebook.com/v23.0/dialog/oauth?state=opaque',
      expiresAt: 123,
    }));

    await beginFacebookConnection();

    expect(apiMock.post).toHaveBeenCalledWith('/facebook/connect', {});
    expect(assign).toHaveBeenCalledWith('https://www.facebook.com/v23.0/dialog/oauth?state=opaque');
  });

  it.each([
    'http://www.facebook.com/dialog/oauth',
    'https://facebook.com.attacker.test/dialog/oauth',
    'https://attacker.test/dialog/oauth',
  ])('rejects an unsafe authorization URL: %s', async (authorizationUrl) => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    apiMock.post.mockResolvedValue(envelope({ authorizationUrl, expiresAt: 123 }));

    await expect(beginFacebookConnection()).rejects.toThrow('invalid Facebook authorization address');
    expect(assign).not.toHaveBeenCalled();
  });

  it('requires the explicit enableAiMessaging approval flag and URL-encodes the Page ID', async () => {
    apiMock.post.mockResolvedValue(envelope({ page: { id: 'page/id' } }));

    await approveFacebookPage('page/id');

    expect(apiMock.post).toHaveBeenCalledWith(
      '/facebook/pages/page%2Fid/approve',
      { enableAiMessaging: true },
    );
  });

  it('keeps approval toggling separate from disconnecting the Page', async () => {
    apiMock.patch.mockResolvedValue(envelope({ id: '42', aiMessagingReady: true, aiMessagingEnabled: false }));
    apiMock.request.mockResolvedValue(envelope({ id: '42', disconnected: true, aiMessagingEnabled: false }));

    await setFacebookAiMessaging('42', false);
    await disconnectFacebookPage('42');

    expect(apiMock.patch).toHaveBeenCalledWith('/facebook/pages/42/ai', { enabled: false });
    expect(apiMock.request).toHaveBeenCalledWith('/facebook/pages/42', { method: 'DELETE' });
  });
});
