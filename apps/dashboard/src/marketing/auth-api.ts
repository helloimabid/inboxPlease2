const CONFIGURED_API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
const API_ORIGIN = CONFIGURED_API_URL === '/api'
  ? ''
  : CONFIGURED_API_URL.replace(/\/api$/, '');

interface AuthJsCsrfResponse {
  csrfToken?: unknown;
}

interface AuthJsRedirectResponse {
  url?: unknown;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function validatedFacebookAuthorizationUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://www.facebook.com'
      || !/^\/v\d+(?:\.\d+)?\/dialog\/oauth$/.test(url.pathname)
      || url.username
      || url.password
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

/** Start Auth.js Facebook OAuth with a validated browser navigation to Meta. */
export async function continueWithFacebook(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/authjs/csrf`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new AuthenticationError('We could not reach InboxPlease. Check your connection and try again.', 0);
  }

  const payload = await response.json().catch(() => undefined) as AuthJsCsrfResponse | undefined;
  const csrfToken = typeof payload?.csrfToken === 'string' ? payload.csrfToken : '';
  if (!response.ok || !csrfToken) {
    throw new AuthenticationError(
      'Facebook sign-in is not available right now. Please try again shortly.',
      response.status || 502,
    );
  }

  let signInResponse: Response;
  try {
    signInResponse = await fetch(`${API_ORIGIN}/authjs/signin/facebook`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({
        csrfToken,
        callbackUrl: `${window.location.origin}/app`,
      }),
    });
  } catch {
    throw new AuthenticationError('We could not reach InboxPlease. Check your connection and try again.', 0);
  }

  const signInPayload = await signInResponse.json().catch(() => undefined) as
    AuthJsRedirectResponse | undefined;
  const authorizationUrl = validatedFacebookAuthorizationUrl(signInPayload?.url);
  if (!signInResponse.ok || !authorizationUrl) {
    throw new AuthenticationError(
      'Facebook sign-in is not available right now. Please try again shortly.',
      signInResponse.status || 502,
    );
  }

  window.location.assign(authorizationUrl.href);
}
