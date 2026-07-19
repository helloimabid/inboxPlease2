import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  MERCHANT_ADMIN_ROLES,
  ORDER_MUTATION_ROLES,
  requireRole,
  verifySessionToken,
} from '../src/auth';
import { ApiError } from '../src/errors';
import type { AppEnv, AuthContext, Bindings } from '../src/env';

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function token(secret: string, claims: Record<string, unknown>): Promise<string> {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  ));
  let binary = '';
  for (const byte of signed) binary += String.fromCharCode(byte);
  const signature = btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${payload}.${signature}`;
}

describe('session authentication', () => {
  const secret = 'this-secret-is-at-least-thirty-two-bytes-long';
  const env = {
    AUTH_SECRET: secret,
    AUTH_ISSUER: 'inboxplease',
    AUTH_AUDIENCE: 'dashboard',
  } as Bindings;

  it('accepts a correctly scoped token', async () => {
    const jwt = await token(secret, {
      sub: 'user-1',
      merchant_id: 'merchant-1',
      role: 'owner',
      iss: 'inboxplease',
      aud: 'dashboard',
      exp: 2_000,
    });
    await expect(verifySessionToken(jwt, env, 1_000)).resolves.toMatchObject({
      merchantId: 'merchant-1',
      subject: 'user-1',
      role: 'owner',
    });
  });

  it('rejects expired and cross-audience tokens', async () => {
    const expired = await token(secret, {
      sub: 'u', merchant_id: 'm', iss: 'inboxplease', aud: 'dashboard', exp: 999,
    });
    await expect(verifySessionToken(expired, env, 1_000)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    const wrongAudience = await token(secret, {
      sub: 'u', merchant_id: 'm', iss: 'inboxplease', aud: 'other', exp: 2_000,
    });
    await expect(verifySessionToken(wrongAudience, env, 1_000)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects unrecognized authorization roles', async () => {
    const jwt = await token(secret, {
      sub: 'u', merchant_id: 'm', role: 'superuser',
      iss: 'inboxplease', aud: 'dashboard', exp: 2_000,
    });
    await expect(verifySessionToken(jwt, env, 1_000)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects tokens that omit an authorization role', async () => {
    const jwt = await token(secret, {
      sub: 'u', merchant_id: 'm',
      iss: 'inboxplease', aud: 'dashboard', exp: 2_000,
    });
    await expect(verifySessionToken(jwt, env, 1_000)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });
});

function authorizationApp(role: AuthContext['role']) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      merchantId: 'merchant-1',
      subject: 'user-1',
      role,
      source: 'session',
    });
    await next();
  });
  app.get('/resource', (c) => c.json({ ok: true }));
  app.post('/merchant-admin', requireRole(...MERCHANT_ADMIN_ROLES), (c) => c.json({ ok: true }));
  app.post('/order', requireRole(...ORDER_MUTATION_ROLES), (c) => c.json({ ok: true }));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ code: error.code }, error.status);
    throw error;
  });
  return app;
}

describe('role authorization middleware', () => {
  it.each<AuthContext['role']>(['owner', 'admin']) (
    'allows %s to perform merchant administration mutations',
    async (role) => {
      expect((await authorizationApp(role).request('/merchant-admin', { method: 'POST' })).status).toBe(200);
    },
  );

  it.each<AuthContext['role']>(['staff', 'service']) (
    'denies %s merchant administration mutations',
    async (role) => {
      const response = await authorizationApp(role).request('/merchant-admin', { method: 'POST' });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ code: 'ROLE_FORBIDDEN' });
    },
  );

  it.each<AuthContext['role']>(['owner', 'admin', 'staff']) (
    'allows %s to perform order mutations',
    async (role) => {
      expect((await authorizationApp(role).request('/order', { method: 'POST' })).status).toBe(200);
    },
  );

  it('denies service identities order mutations but preserves reads', async () => {
    const app = authorizationApp('service');
    expect((await app.request('/order', { method: 'POST' })).status).toBe(403);
    expect((await app.request('/resource')).status).toBe(200);
  });
});
