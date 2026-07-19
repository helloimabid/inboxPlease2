import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { requireAuth } from '../src/auth';
import { signSessionToken } from '../src/auth-accounts';
import type { AppEnv, Bindings } from '../src/env';
import { errorResponse } from '../src/errors';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('active account enforcement', () => {
  it('invalidates bearer sessions when membership role or status changes', async () => {
    const sqlite = migratedDatabase();
    databases.push(sqlite);
    sqlite.exec(`
      INSERT INTO merchants (id, name, status) VALUES ('merchant-1', 'Shop', 'active');
      INSERT INTO users (
        id, name, email, email_normalized,
        password_hash, password_salt, password_iterations, status
      ) VALUES (
        'user-1', 'Owner', 'owner@example.com', 'owner@example.com',
        'hash', 'salt', 600000, 'active'
      );
      INSERT INTO merchant_memberships (user_id, merchant_id, role, status)
      VALUES ('user-1', 'merchant-1', 'owner', 'active');
    `);
    const env = {
      DB: d1FromSqlite(sqlite),
      AUTH_SECRET: 'bearer-test-secret-that-is-at-least-thirty-two-bytes',
      AUTH_ISSUER: 'inboxplease',
      AUTH_AUDIENCE: 'dashboard',
      D1_SCHEMA_READY: 'true',
      ENVIRONMENT: 'test',
      DEV_MODE: 'false',
    } as unknown as Bindings;
    const app = new Hono<AppEnv>()
      .use('/protected', requireAuth)
      .get('/protected', (c) => c.json(c.get('auth')));
    app.onError((error, c) => errorResponse(c, error));

    const ownerToken = await signSessionToken(env, {
      userId: 'user-1', merchantId: 'merchant-1', role: 'owner',
    });
    const request = (token: string) => app.request('http://localhost/protected', {
      headers: { Authorization: `Bearer ${token}` },
    }, env);
    expect((await request(ownerToken)).status).toBe(200);

    sqlite.prepare(`
      UPDATE merchant_memberships SET role = 'admin'
      WHERE user_id = 'user-1' AND merchant_id = 'merchant-1'
    `).run();
    const stale = await request(ownerToken);
    expect(stale.status).toBe(403);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'SESSION_STALE' } });

    const adminToken = await signSessionToken(env, {
      userId: 'user-1', merchantId: 'merchant-1', role: 'admin',
    });
    expect((await request(adminToken)).status).toBe(200);
    sqlite.prepare(`
      UPDATE merchant_memberships SET status = 'revoked'
      WHERE user_id = 'user-1' AND merchant_id = 'merchant-1'
    `).run();
    const revoked = await request(adminToken);
    expect(revoked.status).toBe(403);
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: 'ACCOUNT_INACTIVE' },
    });
  });
});
