import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env';
import {
  facebookMessagingAppSecret,
  facebookMessagingCredentials,
  optionalFacebookLoginCredentials,
} from '../src/integrations/facebook-config';

describe('Facebook app credential separation', () => {
  it('uses the login app only for authentication and the Messenger app for Pages', () => {
    const env = {
      AUTH_FACEBOOK_ID: '1234567890',
      AUTH_FACEBOOK_SECRET: 'login-secret',
      META_APP_ID: '9988776655',
      META_APP_SECRET: 'messaging-secret',
    } as Bindings;

    expect(optionalFacebookLoginCredentials(env)).toEqual({
      appId: '1234567890',
      appSecret: 'login-secret',
    });
    expect(facebookMessagingCredentials(env)).toEqual({
      appId: '9988776655',
      appSecret: 'messaging-secret',
    });
    expect(facebookMessagingAppSecret(env)).toBe('messaging-secret');
  });

  it('keeps a backward-compatible single-app fallback', () => {
    const env = {
      AUTH_FACEBOOK_ID: '1234567890',
      AUTH_FACEBOOK_SECRET: 'shared-secret',
    } as Bindings;

    expect(facebookMessagingCredentials(env)).toEqual({
      appId: '1234567890',
      appSecret: 'shared-secret',
    });
  });

  it('fails closed when only half of the Messenger credential pair is configured', () => {
    const env = {
      AUTH_FACEBOOK_ID: '1234567890',
      AUTH_FACEBOOK_SECRET: 'login-secret',
      META_APP_ID: '9988776655',
    } as Bindings;

    expect(() => facebookMessagingCredentials(env)).toThrowError(
      expect.objectContaining({ code: 'FACEBOOK_MESSAGING_APP_CONFIG_INCOMPLETE' }),
    );
  });
});
