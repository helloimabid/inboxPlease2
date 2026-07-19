import type { Bindings } from '../env';
import { ApiError } from '../errors';

export interface FacebookAppCredentials {
  appId: string;
  appSecret: string;
}

function configured(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function optionalCredentialPair(
  appIdValue: string | undefined,
  appSecretValue: string | undefined,
  purpose: 'authentication' | 'Page messaging',
): FacebookAppCredentials | null {
  const appId = configured(appIdValue);
  const appSecret = configured(appSecretValue);
  if (!appId && !appSecret) return null;
  if (!appId || !appSecret) {
    throw new ApiError(
      503,
      purpose === 'authentication'
        ? 'FACEBOOK_APP_CONFIG_INCOMPLETE'
        : 'FACEBOOK_MESSAGING_APP_CONFIG_INCOMPLETE',
      `Facebook ${purpose} app ID and app secret must be configured together`,
    );
  }
  if (!/^\d{5,32}$/.test(appId)) {
    throw new ApiError(
      503,
      purpose === 'authentication'
        ? 'FACEBOOK_APP_CONFIG_INVALID'
        : 'FACEBOOK_MESSAGING_APP_CONFIG_INVALID',
      `Facebook ${purpose} app ID must be numeric`,
    );
  }
  return { appId, appSecret };
}

/** Credentials for the login-only Facebook app used by Auth.js. */
export function optionalFacebookLoginCredentials(
  env: Bindings,
): FacebookAppCredentials | null {
  return optionalCredentialPair(
    env.AUTH_FACEBOOK_ID,
    env.AUTH_FACEBOOK_SECRET,
    'authentication',
  );
}

/**
 * Credentials for the Messenger-capable app used by Page onboarding and
 * webhook verification. A single-app deployment remains supported when the
 * dedicated META_* pair is omitted.
 */
export function optionalFacebookMessagingCredentials(
  env: Bindings,
): FacebookAppCredentials | null {
  const dedicated = optionalCredentialPair(
    env.META_APP_ID,
    env.META_APP_SECRET,
    'Page messaging',
  );
  return dedicated ?? optionalFacebookLoginCredentials(env);
}

export function facebookMessagingCredentials(env: Bindings): FacebookAppCredentials {
  const credentials = optionalFacebookMessagingCredentials(env);
  if (!credentials) {
    throw new ApiError(
      503,
      'FACEBOOK_MESSAGING_NOT_CONFIGURED',
      'Facebook Page messaging is not configured',
    );
  }
  return credentials;
}

export function facebookMessagingAppSecret(env: Bindings): string {
  return facebookMessagingCredentials(env).appSecret;
}
