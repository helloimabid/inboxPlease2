import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationError, continueWithFacebook } from '../src/marketing/auth-api';

function installBrowserFixture() {
  const assign = vi.fn();
  vi.stubGlobal('window', {
    location: {
      origin: 'https://app.inboxplease.test',
      assign,
    },
  });
  return { assign };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Facebook-only authentication client', () => {
  it('requests a JSON OAuth redirect and navigates only to Facebook', async () => {
    const { assign } = installBrowserFixture();
    const facebookUrl = 'https://www.facebook.com/v21.0/dialog/oauth?client_id=123&state=opaque';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ csrfToken: 'csrf-token' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ url: facebookUrl }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    await continueWithFacebook();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/authjs/csrf', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/authjs/signin/facebook', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({
        csrfToken: 'csrf-token',
        callbackUrl: 'https://app.inboxplease.test/app',
      }),
    });
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(facebookUrl);
  });

  it('fails closed when Auth.js does not return a CSRF token', async () => {
    installBrowserFixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));

    await expect(continueWithFacebook()).rejects.toEqual(expect.objectContaining<Partial<AuthenticationError>>({
      name: 'AuthenticationError',
      status: 503,
    }));
  });

  it('refuses a non-Facebook redirect returned by the authentication endpoint', async () => {
    const { assign } = installBrowserFixture();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ csrfToken: 'csrf-token' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ url: 'https://attacker.example/oauth' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )));

    await expect(continueWithFacebook()).rejects.toEqual(expect.objectContaining<Partial<AuthenticationError>>({
      name: 'AuthenticationError',
      status: 200,
    }));
    expect(assign).not.toHaveBeenCalled();
  });
});
