import type { AuthUser } from '@hono/auth-js';
import { Hono, type Context } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth-accounts';
import { ensureFacebookSellerIdentity } from '../src/auth-account-service';
import { requireAuth } from '../src/auth';
import {
  AUTHJS_BASE_PATH,
  authContextFromAuthJs,
  authJsRoutes,
  createAuthJsConfig,
  initAuthJs,
  safeAuthRedirect,
} from '../src/authjs';
import type { AppEnv, Bindings } from '../src/env';
import { errorResponse } from '../src/errors';
import { authAccountRoutes } from '../src/routes/auth-accounts';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];
const authSecret = 'authjs-test-secret-that-is-at-least-thirty-two-bytes';

function testEnv(overrides: Partial<Bindings> = {}) {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  const env = {
    DB: d1FromSqlite(sqlite),
    AUTH_SECRET: authSecret,
    AUTH_ISSUER: 'inboxplease',
    AUTH_AUDIENCE: 'inboxplease-dashboard',
    AUTH_FACEBOOK_ID: '1234567890',
    AUTH_FACEBOOK_SECRET: 'facebook-test-secret',
    META_APP_ID: '9988776655',
    META_APP_SECRET: 'messaging-test-secret',
    DASHBOARD_ORIGIN: 'http://dashboard.localhost',
    ENVIRONMENT: 'test',
    DEV_MODE: 'false',
    ...overrides,
  } as unknown as Bindings;
  return { sqlite, env };
}

function setCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = extended.getSetCookie?.();
  if (values && values.length > 0) return values;
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function absorbCookies(jar: Map<string, string>, response: Response) {
  for (const value of setCookieValues(response.headers)) {
    const pair = value.split(';', 1)[0];
    if (!pair) continue;
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (/Max-Age=0/i.test(value) || cookieValue === '') jar.delete(name);
    else jar.set(name, cookieValue);
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('Auth.js configuration and session routes', () => {
  it('redirects only to relative, API-origin, or exact dashboard-origin URLs', () => {
    const api = 'https://api.inboxplease.example';
    const dashboard = 'https://app.inboxplease.example';
    expect(safeAuthRedirect('/auth/complete', api, dashboard))
      .toBe('https://api.inboxplease.example/auth/complete');
    expect(safeAuthRedirect(`${dashboard}/app?connected=1`, api, dashboard))
      .toBe('https://app.inboxplease.example/app?connected=1');
    expect(safeAuthRedirect(`${api}/health`, api, dashboard))
      .toBe('https://api.inboxplease.example/health');
    expect(safeAuthRedirect('https://evil.example/app', api, dashboard)).toBe(api);
    expect(safeAuthRedirect('//evil.example/app', api, dashboard)).toBe(api);
    expect(safeAuthRedirect(
      'https://attacker@app.inboxplease.example/app', api, dashboard,
    )).toBe(api);
  });

  it('uses Facebook as the sole default provider without unsafe email linking or token storage', () => {
    const { env } = testEnv();
    const config = createAuthJsConfig({ env } as unknown as Context<AppEnv>);
    expect(config.basePath).toBe(AUTHJS_BASE_PATH);
    expect(config.session).toMatchObject({ strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 });
    expect(config.providers).toHaveLength(1);
    const provider = typeof config.providers[0] === 'function'
      ? config.providers[0]()
      : config.providers[0];
    if (!provider) throw new Error('Facebook provider was not configured');
    expect(provider).toMatchObject({
      id: 'facebook',
      type: 'oauth',
    });
    const options = 'options' in provider ? provider.options : undefined;
    expect(options).toMatchObject({
      allowDangerousEmailAccountLinking: false,
      checks: ['pkce', 'state'],
      authorization: {
        url: 'https://www.facebook.com/v21.0/dialog/oauth',
        params: { scope: 'public_profile' },
      },
    });
    const accountMapper = (options && 'account' in options ? options.account : undefined) as
      ((tokens: Record<string, unknown>) => Record<string, unknown>) | undefined;
    expect(accountMapper?.({ access_token: 'must-not-be-persisted' } as never)).toEqual({});
    expect(config.adapter).toMatchObject({
      createUser: expect.any(Function),
      getUser: expect.any(Function),
      linkAccount: expect.any(Function),
      createSession: expect.any(Function),
    });
  });

  it('exposes password credentials only when the recovery switch is explicit', () => {
    const { env } = testEnv({ AUTH_PASSWORD_FALLBACK_ENABLED: 'true' });
    const config = createAuthJsConfig({ env } as unknown as Context<AppEnv>);
    expect(config.providers.map((entry) => {
      const provider = typeof entry === 'function' ? entry() : entry;
      return provider.id;
    })).toEqual(['facebook', 'credentials']);
  });

  it('starts standard Facebook Login with identity-only scope and the exact callback', async () => {
    const { env } = testEnv();
    const app = new Hono<AppEnv>()
      .use('*', initAuthJs)
      .route(AUTHJS_BASE_PATH, authJsRoutes);
    app.onError((error, c) => errorResponse(c, error));
    const jar = new Map<string, string>();
    const csrfResponse = await app.request('http://localhost/authjs/csrf', {}, env);
    absorbCookies(jar, csrfResponse);
    const csrf = await csrfResponse.json<{ csrfToken: string }>();

    const response = await app.request('http://localhost/authjs/signin/facebook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(jar),
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        callbackUrl: 'http://dashboard.localhost/app',
      }),
    }, env);
    expect(response.status).toBe(200);
    const authorizationCookies = response.headers.get('Set-Cookie') ?? '';
    expect(authorizationCookies).toContain('authjs.state');
    expect(authorizationCookies).toContain('authjs.pkce.code_verifier');
    const result = await response.json<{ url: string }>();
    const authorization = new URL(result.url);
    expect(authorization.origin).toBe('https://www.facebook.com');
    expect(authorization.pathname).toBe('/v21.0/dialog/oauth');
    expect(authorization.searchParams.get('client_id')).toBe('1234567890');
    expect(authorization.searchParams.get('scope')).toBe('public_profile');
    expect(authorization.searchParams.has('config_id')).toBe(false);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.has('override_default_response_type')).toBe(false);
    expect(authorization.searchParams.get('redirect_uri'))
      .toBe('http://localhost/authjs/callback/facebook');
  });

  it('bootstraps one owner tenant for Facebook users without requiring an email', async () => {
    const { sqlite, env } = testEnv();
    sqlite.prepare(`
      INSERT INTO users (id, name, email, email_normalized, status)
      VALUES (?, ?, NULL, NULL, 'active')
    `).run('facebook-user-1', '  Ada   Seller  ');
    sqlite.prepare(`
      INSERT INTO accounts (id, userId, type, provider, providerAccountId)
      VALUES (?, ?, 'oauth', 'facebook', ?)
    `).run('facebook-account-1', 'facebook-user-1', '100000000000001');

    const config = createAuthJsConfig({ env } as unknown as Context<AppEnv>);
    const jwt = config.callbacks?.jwt;
    expect(jwt).toBeTypeOf('function');
    const token = await jwt?.({
      token: {},
      user: { id: 'facebook-user-1', name: 'Ada Seller' },
      account: {
        provider: 'facebook',
        type: 'oauth',
        providerAccountId: '100000000000001',
      },
      profile: { id: '100000000000001' },
      trigger: 'signUp',
      isNewUser: true,
    } as never);
    const first = await ensureFacebookSellerIdentity(env, {
      id: 'facebook-user-1',
      name: 'Ada Seller',
    });
    const second = await ensureFacebookSellerIdentity(env, {
      id: 'facebook-user-1',
      name: 'Ada Seller',
    });

    expect(first).toMatchObject({
      user: { id: 'facebook-user-1', name: 'Ada Seller', email: null },
      merchant: { name: "Ada Seller's store", plan: 'free' },
      role: 'owner',
    });
    expect(second.merchant.id).toBe(first.merchant.id);
    expect(token).toMatchObject({
      sub: 'facebook-user-1', merchantId: first.merchant.id, role: 'owner',
      facebookAccountId: '100000000000001',
    });
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM merchant_memberships WHERE user_id = ?',
    ).get('facebook-user-1')).toMatchObject({ count: 1 });
  });

  it('keeps the legacy password HTTP surface closed by default', async () => {
    const { env } = testEnv();
    const app = new Hono<AppEnv>().route('/auth', authAccountRoutes);
    app.onError((error, c) => errorResponse(c, error));
    const response = await app.request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seller@example.com', password: 'not-used-here' }),
    }, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTH_METHOD_DISABLED' },
    });
  });

  it('does not reopen password signup during a production recovery window', async () => {
    const { env } = testEnv({ AUTH_PASSWORD_FALLBACK_ENABLED: 'true' });
    const app = new Hono<AppEnv>().route('/auth', authAccountRoutes);
    app.onError((error, c) => errorResponse(c, error));
    const response = await app.request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTH_METHOD_DISABLED' },
    });
  });

  it('does not bypass a revoked Facebook seller membership with a new tenant', async () => {
    const { sqlite, env } = testEnv();
    sqlite.exec(`
      INSERT INTO users (id, name, status) VALUES ('facebook-user-2', 'Revoked Seller', 'active');
      INSERT INTO accounts (id, userId, type, provider, providerAccountId)
      VALUES ('facebook-account-2', 'facebook-user-2', 'oauth', 'facebook', 'facebook-profile-2');
      INSERT INTO merchants (id, name, status) VALUES ('merchant-revoked', 'Old Store', 'active');
      INSERT INTO merchant_memberships (user_id, merchant_id, role, status)
      VALUES ('facebook-user-2', 'merchant-revoked', 'owner', 'revoked');
    `);

    await expect(ensureFacebookSellerIdentity(env, {
      id: 'facebook-user-2',
      name: 'Revoked Seller',
    })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_INACTIVE' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM merchants').get())
      .toMatchObject({ count: 1 });
  });

  it('refuses tenant bootstrap before the Facebook account link exists', async () => {
    const { sqlite, env } = testEnv();
    sqlite.prepare(`
      INSERT INTO users (id, name, status) VALUES (?, ?, 'active')
    `).run('unlinked-user', 'Unlinked Seller');
    await expect(ensureFacebookSellerIdentity(env, {
      id: 'unlinked-user', name: 'Unlinked Seller',
    })).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_NOT_LINKED' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM merchants').get())
      .toMatchObject({ count: 0 });
  });

  it('maps only complete merchant-scoped tokens into API authorization', () => {
    const authUser = (token: Record<string, unknown>): AuthUser => ({
      session: { expires: new Date(Date.now() + 60_000).toISOString() },
      token,
    });
    expect(authContextFromAuthJs(authUser({
      sub: 'user-1', merchantId: 'merchant-1', role: 'owner',
      facebookAccountId: '100000000000002',
    }))).toEqual({
      subject: 'user-1', merchantId: 'merchant-1', role: 'owner', source: 'session',
      facebookAccountId: '100000000000002',
    });
    expect(authContextFromAuthJs(authUser({ sub: 'user-1', role: 'owner' }))).toBeNull();
    expect(authContextFromAuthJs(authUser({
      sub: 'user-1', merchantId: 'merchant-1', role: 'superuser',
    }))).toBeNull();
    expect(authContextFromAuthJs(null)).toBeNull();
  });

  it('keeps the explicit recovery credentials-to-session cookie flow working', async () => {
    const { sqlite, env } = testEnv({ AUTH_PASSWORD_FALLBACK_ENABLED: 'true' });
    const digest = await hashPassword('CorrectHorse123!');
    sqlite.prepare(`
      INSERT INTO merchants (id, name, plan, status)
      VALUES (?, ?, 'free', 'active')
    `).run('merchant-1', 'Auth.js Shop');
    sqlite.prepare(`
      INSERT INTO users (
        id, name, email, email_normalized,
        password_hash, password_salt, password_iterations, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      'user-1', 'Auth Owner', 'owner@example.com', 'owner@example.com',
      digest.hash, digest.salt, digest.iterations,
    );
    sqlite.prepare(`
      INSERT INTO merchant_memberships (user_id, merchant_id, role, status)
      VALUES (?, ?, 'owner', 'active')
    `).run('user-1', 'merchant-1');

    const app = new Hono<AppEnv>()
      .use('*', initAuthJs)
      .route(AUTHJS_BASE_PATH, authJsRoutes)
      .use('/protected', requireAuth)
      .get('/protected', (c) => c.json(c.get('auth')));
    app.onError((error, c) => errorResponse(c, error));
    const providers = await app.request('http://localhost/authjs/providers', {}, env);
    expect(providers.status).toBe(200);
    await expect(providers.json()).resolves.toMatchObject({
      facebook: { id: 'facebook', type: 'oauth' },
      credentials: { id: 'credentials', type: 'credentials' },
    });

    const jar = new Map<string, string>();
    const csrfResponse = await app.request('http://localhost/authjs/csrf', {}, env);
    expect(csrfResponse.status).toBe(200);
    const csrf = await csrfResponse.json<{ csrfToken: string }>();
    expect(csrf.csrfToken).toMatch(/^[a-f0-9-]{16,}$/i);
    absorbCookies(jar, csrfResponse);

    const callback = await app.request('http://localhost/authjs/callback/credentials', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(jar),
        'X-Auth-Return-Redirect': '1',
      },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email: 'OWNER@EXAMPLE.COM',
        password: 'CorrectHorse123!',
        callbackUrl: 'http://localhost/',
      }),
    }, env);
    expect(callback.status).toBe(200);
    absorbCookies(jar, callback);
    expect([...jar.keys()].some((name) => name.endsWith('authjs.session-token'))).toBe(true);

    const session = await app.request('http://localhost/authjs/session', {
      headers: { Cookie: cookieHeader(jar) },
    }, env);
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      user: {
        id: 'user-1',
        email: 'owner@example.com',
        merchantId: 'merchant-1',
        role: 'owner',
      },
    });

    const protectedResponse = await app.request('http://localhost/protected', {
      headers: { Cookie: cookieHeader(jar) },
    }, env);
    expect(protectedResponse.status).toBe(200);
    await expect(protectedResponse.json()).resolves.toMatchObject({
      subject: 'user-1', merchantId: 'merchant-1', role: 'owner',
    });

    sqlite.prepare(`
      UPDATE merchant_memberships SET status = 'revoked'
      WHERE user_id = ? AND merchant_id = ?
    `).run('user-1', 'merchant-1');
    const revokedResponse = await app.request('http://localhost/protected', {
      headers: { Cookie: cookieHeader(jar) },
    }, env);
    expect(revokedResponse.status).toBe(403);
    await expect(revokedResponse.json()).resolves.toMatchObject({
      error: { code: 'ACCOUNT_INACTIVE' },
    });
  });
});
