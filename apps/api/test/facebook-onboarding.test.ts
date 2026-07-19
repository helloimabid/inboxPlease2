import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Bindings, MetaQueueJob, QueueJob } from '../src/env';
import { requireAuth } from '../src/auth';
import { errorResponse } from '../src/errors';
import {
  FACEBOOK_PAGE_PERMISSIONS,
  FACEBOOK_WEBHOOK_FIELDS,
} from '../src/integrations/facebook-onboarding';
import {
  passThreadToHuman,
  isPageAiAutomationActive,
  sendAiReply,
  sendProactiveOrderUpdate,
} from '../src/integrations/meta';
import { consumeQueue } from '../src/queue';
import {
  cleanupExpiredMetaOnboarding,
  facebookCallbackRoutes,
  facebookRoutes,
  reconcileFacebookPageSubscriptions,
} from '../src/routes/facebook';
import { encryptSecret, isEncryptedSecret } from '../src/secret-envelope';
import { base64Encode, sha256Name } from '../src/security';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];
const encryptionKey = base64Encode(new Uint8Array(32).fill(17));

function fixture() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Page Shop');
    INSERT INTO users (id, name, email, email_normalized, status)
    VALUES ('user-1', 'Seller', 'seller@example.com', 'seller@example.com', 'active');
    INSERT INTO merchant_memberships (user_id, merchant_id, role, status)
    VALUES ('user-1', 'merchant-1', 'owner', 'active');
    INSERT INTO accounts (id, userId, type, provider, providerAccountId)
    VALUES ('account-1', 'user-1', 'oauth', 'facebook', '123456789');
    INSERT INTO accounts (id, userId, type, provider, providerAccountId)
    VALUES ('account-0', 'user-1', 'oauth', 'facebook', '999999999');
  `);
  const env = {
    DB: d1FromSqlite(sqlite),
    AUTH_FACEBOOK_ID: '1234567890',
    AUTH_FACEBOOK_SECRET: 'facebook-app-secret',
    META_APP_ID: '9988776655',
    META_APP_SECRET: 'messaging-app-secret',
    META_GRAPH_VERSION: 'v21.0',
    META_TOKEN_ENCRYPTION_KEY: encryptionKey,
    PUBLIC_API_BASE_URL: 'https://api.example.com',
    DASHBOARD_ORIGIN: 'https://dashboard.example.com',
    AI_ENABLED: 'true',
    MESSAGING_ENABLED: 'true',
    PROACTIVE_ORDER_UPDATES_ENABLED: 'true',
    HANDOFF_ON_COMPLAINT: 'true',
    META_HANDOVER_TARGET_APP_ID: 'human-app',
  } as unknown as Bindings;
  const authenticated = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('requestId', 'request-1');
      c.set('auth', {
        subject: 'user-1',
        merchantId: 'merchant-1',
        role: 'owner',
        source: 'session',
        facebookAccountId: '123456789',
      });
      await next();
    })
    .route('/', facebookRoutes);
  authenticated.onError((error, c) => errorResponse(c, error));
  const callback = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('requestId', 'request-1');
      c.set('auth', {
        subject: 'user-1',
        merchantId: 'merchant-1',
        role: 'owner',
        source: 'session',
        facebookAccountId: '123456789',
      });
      await next();
    })
    .route('/', facebookCallbackRoutes);
  callback.onError((error, c) => errorResponse(c, error));
  return { sqlite, env, authenticated, callback };
}

function graphFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/oauth/access_token')) {
      const body = init?.body as URLSearchParams;
      expect(body.get('client_id')).toBe('9988776655');
      expect(body.get('client_secret')).toBe('messaging-app-secret');
      return Response.json({
        access_token: body.get('grant_type') === 'fb_exchange_token'
          ? 'long-lived-user-token-123456789'
          : 'short-lived-user-token-12345678',
      });
    }
    expect(url.searchParams.get('appsecret_proof')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.has('access_token')).toBe(false);
    if (url.pathname.endsWith('/me/permissions')) {
      return Response.json({
        data: FACEBOOK_PAGE_PERMISSIONS.map((permission) => ({
          permission,
          status: 'granted',
        })),
      });
    }
    if (url.pathname.endsWith('/me/accounts')) {
      return Response.json({
        data: [{
          id: '987654321',
          name: 'Seller Page',
          access_token: 'page-access-token-123456789',
          tasks: ['PROFILE_PLUS_MESSAGING', 'MODERATE'],
        }],
      });
    }
    if (url.pathname.endsWith('/me')) return Response.json({ id: '123456789' });
    if (url.pathname.endsWith('/987654321/subscribed_apps')) {
      const body = init?.body as URLSearchParams;
      expect(init?.method).toBe('POST');
      expect(body.get('subscribed_fields')?.split(',')).toEqual(FACEBOOK_WEBHOOK_FIELDS);
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer page-access-token-123456789',
      });
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected Graph request ${url.pathname}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length > 0) databases.pop()?.close();
});

describe('Facebook Page onboarding', () => {
  it('requires an active dashboard session at the Page OAuth callback boundary', async () => {
    const { env } = fixture();
    const protectedCallback = new Hono<AppEnv>()
      .use('*', (c, next) => {
        c.set('requestId', 'request-1');
        return next();
      })
      .use('*', requireAuth)
      .route('/', facebookCallbackRoutes);
    protectedCallback.onError((error, c) => errorResponse(c, error));

    const response = await protectedCallback.request(
      'https://api.example.com/callback?code=oauth-code&state=unknown',
      {},
      env,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTH_REQUIRED' },
    });
  });

  it('adds auditable Page onboarding state and prevents incomplete AI enablement', () => {
    const sqlite = migratedDatabase();
    databases.push(sqlite);
    const tables = sqlite.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'meta_%' ORDER BY name`,
    ).all().map((row) => row.name);
    expect(tables).toEqual(['meta_onboarding_sessions', 'meta_page_candidates']);
    sqlite.exec(`
      INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Shop');
      INSERT INTO store_pages (id, merchant_id, name)
      VALUES ('123', 'merchant-1', 'Page');
    `);
    expect(() => sqlite.exec(
      `UPDATE store_pages SET ai_messaging_enabled = 1 WHERE id = '123'`,
    )).toThrow(/approval is incomplete/);
    sqlite.exec(`
      INSERT INTO users (id, name, status) VALUES ('approver-1', 'Approver', 'active');
      UPDATE store_pages SET
        meta_page_access_token = 'enc.v1.iv.ciphertext',
        meta_subscription_status = 'subscribed',
        meta_permissions_json = '["pages_show_list","pages_manage_metadata","pages_messaging"]',
        meta_tasks_json = '["PROFILE_PLUS_MESSAGING"]',
        messaging_ready_at = unixepoch(),
        ai_messaging_enabled = 1,
        ai_messaging_approved_at = unixepoch(),
        ai_messaging_approved_by_user_id = 'approver-1'
      WHERE id = '123';
      DELETE FROM users WHERE id = 'approver-1';
    `);
    expect(sqlite.prepare(`
      SELECT ai_messaging_enabled, ai_messaging_approved_by_user_id
      FROM store_pages WHERE id = '123'
    `).get()).toEqual({
      ai_messaging_enabled: 0,
      ai_messaging_approved_by_user_id: null,
    });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('uses one-time state, keeps Page tokens server-only, and records explicit approval', async () => {
    const { sqlite, env, authenticated, callback } = fixture();
    const fetchMock = graphFetch();
    vi.stubGlobal('fetch', fetchMock);

    const start = await authenticated.request('https://api.example.com/connect', {
      method: 'POST',
    }, env);
    expect(start.status).toBe(201);
    const startBody = await start.json<{
      data: { authorizationUrl: string; expiresAt: number };
    }>();
    const authorization = new URL(startBody.data.authorizationUrl);
    const state = authorization.searchParams.get('state');
    expect(authorization.origin).toBe('https://www.facebook.com');
    expect(authorization.searchParams.get('client_id')).toBe('9988776655');
    expect(authorization.searchParams.get('redirect_uri'))
      .toBe('https://api.example.com/facebook/callback');
    expect(authorization.searchParams.get('scope')?.split(','))
      .toEqual(FACEBOOK_PAGE_PERMISSIONS);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const storedState = sqlite.prepare(
      'SELECT state_digest, facebook_user_id FROM meta_onboarding_sessions',
    ).get() as { state_digest: string; facebook_user_id: string };
    expect(storedState.state_digest).not.toBe(state);
    expect(storedState.state_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(storedState.facebook_user_id).toBe('123456789');

    const complete = await callback.request(
      `https://api.example.com/callback?code=oauth-code&state=${state}`,
      {},
      env,
    );
    expect(complete.status).toBe(303);
    expect(complete.headers.get('location')).toBe(
      'https://dashboard.example.com/app?view=facebook&facebook=pages-ready',
    );
    const candidate = sqlite.prepare(
      `SELECT access_token_encrypted, tasks_json FROM meta_page_candidates
       WHERE page_id = '987654321'`,
    ).get() as { access_token_encrypted: string; tasks_json: string };
    expect(isEncryptedSecret(candidate.access_token_encrypted)).toBe(true);
    expect(candidate.access_token_encrypted).not.toContain('page-access-token');

    const callsAfterCallback = fetchMock.mock.calls.length;
    const replay = await callback.request(
      `https://api.example.com/callback?code=oauth-code&state=${state}`,
      {},
      env,
    );
    expect(replay.headers.get('location')).toContain('facebook=invalid-state');
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterCallback);

    const approve = await authenticated.request(
      'https://api.example.com/pages/987654321/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableAiMessaging: true }),
      },
      env,
    );
    expect(approve.status).toBe(200);
    const approveBody = await approve.json<{ data: { page: Record<string, unknown> } }>();
    expect(approveBody.data.page).toMatchObject({
      id: '987654321',
      webhookSubscribed: true,
      aiMessagingReady: true,
      aiMessagingEnabled: true,
      aiMessagingEffective: true,
    });
    expect(typeof approveBody.data.page.aiMessagingApprovedAt).toBe('number');
    expect(JSON.stringify(approveBody)).not.toContain('page-access-token');

    const persisted = sqlite.prepare(
      `SELECT meta_page_access_token, meta_subscription_status,
              ai_messaging_enabled, ai_messaging_approved_at,
              ai_messaging_approved_by_user_id
       FROM store_pages WHERE id = '987654321'`,
    ).get() as Record<string, unknown>;
    expect(persisted).toMatchObject({
      meta_subscription_status: 'subscribed',
      ai_messaging_enabled: 1,
      ai_messaging_approved_by_user_id: 'user-1',
    });
    expect(isEncryptedSecret(String(persisted.meta_page_access_token))).toBe(true);
    expect(typeof persisted.ai_messaging_approved_at).toBe('number');
    expect(sqlite.prepare(
      'SELECT COUNT(*) AS count FROM meta_page_candidates',
    ).get()).toEqual({ count: 0 });

    const connection = await authenticated.request(
      'https://api.example.com/connection',
      {},
      env,
    );
    const connectionBody = await connection.json<{ data: Record<string, unknown> }>();
    expect(Object.keys(connectionBody.data).sort()).toEqual([
      'allPermissionsGranted',
      'authorizationExpiresAt',
      'candidates',
      'grantedPermissions',
      'lastError',
      'pages',
      'platform',
      'requiredPermissions',
      'status',
    ]);
    expect(connectionBody.data).toMatchObject({
      status: 'enabled',
      grantedPermissions: [...FACEBOOK_PAGE_PERMISSIONS].sort(),
      allPermissionsGranted: true,
      platform: {
        aiEnabled: true,
        messagingEnabled: true,
        aiMessagingAvailable: true,
      },
      pages: [{
        id: '987654321',
        webhookSubscribed: true,
        aiMessagingReady: true,
        aiMessagingEnabled: true,
        aiMessagingEffective: true,
      }],
    });
    expect(JSON.stringify(connectionBody)).not.toContain('page-access-token');
  });

  it('rejects a callback under a different dashboard identity before calling Graph', async () => {
    const { sqlite, env, authenticated } = fixture();
    const start = await authenticated.request('https://api.example.com/connect', {
      method: 'POST',
    }, env);
    const startBody = await start.json<{ data: { authorizationUrl: string } }>();
    const state = new URL(startBody.data.authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const mismatchedCallback = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('requestId', 'request-1');
        c.set('auth', {
          subject: 'different-user',
          merchantId: 'merchant-1',
          role: 'owner',
          source: 'session',
        });
        await next();
      })
      .route('/', facebookCallbackRoutes);
    mismatchedCallback.onError((error, c) => errorResponse(c, error));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mismatchedCallback.request(
      `https://api.example.com/callback?code=oauth-code&state=${state}`,
      {},
      env,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('facebook=failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      'SELECT status, error_code FROM meta_onboarding_sessions ORDER BY created_at DESC LIMIT 1',
    ).get()).toEqual({
      status: 'failed',
      error_code: 'CALLBACK_SESSION_MISMATCH',
    });
  });

  it('fails closed when the Facebook Page lacks the MESSAGING task', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-123456789', encryptionKey);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES (?, ?, 'user-1', 'merchant-1', '123456789', 'pages_ready', ?, ?,
                unixepoch() + 3600, unixepoch())
    `).run(
      'session-no-task',
      'a'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('session-no-task', '444', 'No Messaging Page', ?, '["MODERATE"]')
    `).run(encrypted);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await authenticated.request('https://api.example.com/pages/444/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableAiMessaging: true }),
    }, env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FACEBOOK_PAGE_TASK_MISSING' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT id FROM store_pages WHERE id = '444'").get()).toBeUndefined();
  });

  it('cannot transfer a globally unique Page from another merchant', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-123456789', encryptionKey);
    sqlite.exec(`
      INSERT INTO merchants (id, name) VALUES ('merchant-2', 'Other Shop');
      INSERT INTO store_pages (id, merchant_id, name)
      VALUES ('555', 'merchant-2', 'Already Owned Page');
    `);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES (?, ?, 'user-1', 'merchant-1', '123456789', 'pages_ready', ?, ?,
                unixepoch() + 3600, unixepoch())
    `).run(
      'session-conflict',
      'b'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('session-conflict', '555', 'Candidate Page', ?, '["MESSAGING"]')
    `).run(encrypted);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await authenticated.request('https://api.example.com/pages/555/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableAiMessaging: true }),
    }, env);
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlite.prepare(
      "SELECT merchant_id FROM store_pages WHERE id = '555'",
    ).get()).toEqual({ merchant_id: 'merchant-2' });
    expect(sqlite.prepare(
      "SELECT status FROM meta_onboarding_sessions WHERE id = 'session-conflict'",
    ).get()).toEqual({ status: 'pages_ready' });
  });

  it('keeps one active authorization session and purges expired candidate tokens', async () => {
    const { sqlite, env, authenticated } = fixture();
    const first = await authenticated.request('https://api.example.com/connect', {
      method: 'POST',
    }, env);
    const firstBody = await first.json<{ data: { authorizationUrl: string } }>();
    const firstState = new URL(firstBody.data.authorizationUrl).searchParams.get('state');
    const second = await authenticated.request('https://api.example.com/connect', {
      method: 'POST',
    }, env);
    expect(second.status).toBe(201);
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM meta_onboarding_sessions
       WHERE user_id = 'user-1' AND merchant_id = 'merchant-1'`,
    ).get()).toEqual({ count: 1 });
    const oldDigest = await sha256Name(['facebook-oauth-state', firstState ?? '']);
    expect(sqlite.prepare(
      'SELECT id FROM meta_onboarding_sessions WHERE state_digest = ?',
    ).get(oldDigest)).toBeUndefined();

    const encrypted = await encryptSecret('temporary-page-token-123456', encryptionKey);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, expires_at
      ) VALUES ('expired-session', ?, 'user-1', 'merchant-1', '123456789',
                'pages_ready', ?, unixepoch() - 1)
    `).run('c'.repeat(64), JSON.stringify(FACEBOOK_PAGE_PERMISSIONS));
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('expired-session', '666', 'Expired', ?, '["MESSAGE"]')
    `).run(encrypted);
    await cleanupExpiredMetaOnboarding(env);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS count FROM meta_page_candidates WHERE session_id = 'expired-session'",
    ).get()).toEqual({ count: 0 });
  });

  it('compensates an ambiguous stale connect after a newer disconnect', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-123456789', encryptionKey);
    sqlite.prepare(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token, connected_at,
        meta_subscription_status, meta_permissions_json, meta_tasks_json,
        messaging_ready_at, ai_messaging_enabled, ai_messaging_approved_at,
        ai_messaging_approved_by_user_id
      ) VALUES ('701', 'merchant-1', 'Race Page', ?, unixepoch(), 'subscribed', ?,
                '["MESSAGE"]', unixepoch(), 1, unixepoch(), 'user-1')
    `).run(encrypted, JSON.stringify(FACEBOOK_PAGE_PERMISSIONS));
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES ('race-connect', ?, 'user-1', 'merchant-1', '123456789',
                'pages_ready', ?, ?, unixepoch() + 3600, unixepoch())
    `).run(
      'd'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('race-connect', '701', 'Race Page', ?, '["MESSAGE"]')
    `).run(encrypted);
    const methods: string[] = [];
    let concurrentStatus: number | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        // Model a newer disconnect completing after this connect acquired its
        // lease but before the slow subscription response is observed.
        sqlite.exec(`
          UPDATE store_pages SET ai_messaging_enabled = 0,
            ai_messaging_disabled_at = unixepoch(),
            meta_subscription_status = 'disconnected', messaging_ready_at = NULL,
            connected_at = NULL, disconnected_at = unixepoch(),
            meta_subscription_desired = 0,
            meta_reconcile_after = unixepoch() + 60,
            meta_reconcile_attempts = 0,
            meta_connection_generation = meta_connection_generation + 1,
            meta_operation_id = NULL, meta_operation_kind = NULL,
            meta_operation_expires_at = NULL
          WHERE id = '701'
        `);
        throw new Error('Subscription response was lost');
      }
      const concurrent = await authenticated.request(
        'https://api.example.com/pages/701/ai',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        },
        env,
      );
      concurrentStatus = concurrent.status;
      return Response.json({ success: true });
    }));
    const response = await authenticated.request('https://api.example.com/pages/701/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableAiMessaging: true }),
    }, env);
    expect(response.status).toBe(502);
    expect(methods).toEqual(['POST', 'DELETE']);
    expect(concurrentStatus).toBe(409);
    expect(sqlite.prepare(`
      SELECT meta_subscription_status, ai_messaging_enabled
      FROM store_pages WHERE id = '701'
    `).get()).toEqual({ meta_subscription_status: 'disconnected', ai_messaging_enabled: 0 });
  });

  it('re-subscribes after an ambiguous stale disconnect loses to a newer connect', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-123456789', encryptionKey);
    sqlite.prepare(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token, connected_at,
        meta_subscription_status, meta_permissions_json, meta_tasks_json,
        messaging_ready_at, ai_messaging_enabled, ai_messaging_approved_at,
        ai_messaging_approved_by_user_id
      ) VALUES ('702', 'merchant-1', 'Reconnect Page', ?, unixepoch(), 'subscribed', ?,
                '["PROFILE_PLUS_FULL_CONTROL"]', unixepoch(), 1, unixepoch(), 'user-1')
    `).run(encrypted, JSON.stringify(FACEBOOK_PAGE_PERMISSIONS));
    const methods: string[] = [];
    let concurrentStatus: number | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'DELETE') {
        // Model a newer connect completing while this expired disconnect is
        // still waiting for Meta's DELETE response.
        sqlite.prepare(`
          UPDATE store_pages SET meta_page_access_token = ?,
            meta_subscription_status = 'subscribed', messaging_ready_at = unixepoch(),
            connected_at = unixepoch(), disconnected_at = NULL,
            ai_messaging_enabled = 1,
            meta_subscription_desired = 1,
            meta_reconcile_after = unixepoch() + 60,
            meta_reconcile_attempts = 0,
            meta_connection_generation = meta_connection_generation + 1,
            meta_operation_id = NULL, meta_operation_kind = NULL,
            meta_operation_expires_at = NULL
          WHERE id = '702'
        `).run(encrypted);
        throw new Error('Unsubscribe response was lost');
      }
      const concurrent = await authenticated.request(
        'https://api.example.com/pages/702',
        { method: 'DELETE' },
        env,
      );
      concurrentStatus = concurrent.status;
      return Response.json({ success: true });
    }));
    const response = await authenticated.request('https://api.example.com/pages/702', {
      method: 'DELETE',
    }, env);
    expect(response.status).toBe(502);
    expect(methods).toEqual(['DELETE', 'POST']);
    expect(concurrentStatus).toBe(409);
    expect(sqlite.prepare(`
      SELECT meta_subscription_status, ai_messaging_enabled
      FROM store_pages WHERE id = '702'
    `).get()).toEqual({ meta_subscription_status: 'subscribed', ai_messaging_enabled: 1 });
  });

  it('retains an ambiguous Page credential until scheduled unsubscribe convergence', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-ambiguous', encryptionKey);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES ('ambiguous-connect', ?, 'user-1', 'merchant-1', '123456789',
                'pages_ready', ?, ?, unixepoch() + 3600, unixepoch())
    `).run(
      'e'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('ambiguous-connect', '703', 'Ambiguous Page', ?, '["MESSAGE"]')
    `).run(encrypted);
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      throw new Error('Ambiguous Meta response');
    }));

    const response = await authenticated.request('https://api.example.com/pages/703/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableAiMessaging: true }),
    }, env);
    expect(response.status).toBe(502);
    expect(methods).toEqual(['POST', 'DELETE']);
    const retained = sqlite.prepare(`
      SELECT meta_page_access_token, meta_subscription_status,
             meta_subscription_desired, meta_reconcile_after,
             ai_messaging_enabled
      FROM store_pages WHERE id = '703'
    `).get() as Record<string, unknown>;
    expect(isEncryptedSecret(String(retained.meta_page_access_token))).toBe(true);
    expect(retained).toMatchObject({
      meta_subscription_status: 'unsubscribe_failed',
      meta_subscription_desired: 0,
      ai_messaging_enabled: 0,
    });
    expect(typeof retained.meta_reconcile_after).toBe('number');

    const reconcileMethods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      reconcileMethods.push(init?.method ?? 'GET');
      return Response.json({ success: true });
    }));
    for (let confirmation = 1; confirmation <= 3; confirmation += 1) {
      sqlite.exec("UPDATE store_pages SET meta_reconcile_after = 0 WHERE id = '703'");
      await expect(reconcileFacebookPageSubscriptions(env)).resolves.toEqual({
        selected: 1,
        reconciled: 1,
      });
      const state = sqlite.prepare(`
        SELECT meta_page_access_token, meta_reconcile_after, meta_reconcile_attempts
        FROM store_pages WHERE id = '703'
      `).get() as Record<string, unknown>;
      if (confirmation < 3) {
        expect(isEncryptedSecret(String(state.meta_page_access_token))).toBe(true);
        expect(state.meta_reconcile_attempts).toBe(confirmation);
        expect(typeof state.meta_reconcile_after).toBe('number');
      } else {
        expect(state).toEqual({
          meta_page_access_token: null,
          meta_reconcile_after: null,
          meta_reconcile_attempts: 0,
        });
      }
    }
    expect(reconcileMethods).toEqual(['DELETE', 'DELETE', 'DELETE']);
  });

  it('stops scheduled retries for a permanently invalid reconciliation credential', async () => {
    const { sqlite, env } = fixture();
    sqlite.exec(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token,
        meta_subscription_status, meta_subscription_desired,
        meta_reconcile_after
      ) VALUES (
        '707', 'merchant-1', 'Invalid Token Page', 'not-an-encrypted-envelope',
        'unsubscribe_failed', 0, 0
      )
    `);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileFacebookPageSubscriptions(env)).resolves.toEqual({
      selected: 1,
      reconciled: 0,
    });
    expect(sqlite.prepare(`
      SELECT meta_reconcile_after, meta_reconcile_attempts,
             meta_reconcile_failures, meta_last_error, ai_messaging_enabled
      FROM store_pages WHERE id = '707'
    `).get()).toEqual({
      meta_reconcile_after: null,
      meta_reconcile_attempts: 0,
      meta_reconcile_failures: 1,
      meta_last_error: 'FACEBOOK_RECONCILE_TOKEN_INVALID',
      ai_messaging_enabled: 0,
    });
    await expect(reconcileFacebookPageSubscriptions(env)).resolves.toEqual({
      selected: 0,
      reconciled: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a transient Meta application error returned with HTTP 400', async () => {
    const { sqlite, env } = fixture();
    const encrypted = await encryptSecret('page-access-token-transient', encryptionKey);
    sqlite.prepare(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token,
        meta_subscription_status, meta_subscription_desired,
        meta_reconcile_after
      ) VALUES ('708', 'merchant-1', 'Transient Page', ?, 'subscription_failed', 1, 0)
    `).run(encrypted);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 4, is_transient: true, message: 'not persisted or exposed' },
    }, { status: 400 })));

    await expect(reconcileFacebookPageSubscriptions(env)).resolves.toEqual({
      selected: 1,
      reconciled: 0,
    });
    const state = sqlite.prepare(`
      SELECT meta_reconcile_after, meta_reconcile_failures,
             meta_last_error, ai_messaging_enabled
      FROM store_pages WHERE id = '708'
    `).get() as Record<string, unknown>;
    expect(typeof state.meta_reconcile_after).toBe('number');
    expect(state).toMatchObject({
      meta_reconcile_failures: 1,
      meta_last_error: 'GRAPH_400_RESPONSE',
      ai_messaging_enabled: 0,
    });
    expect(JSON.stringify(state)).not.toContain('not persisted or exposed');
  });

  it('re-checks owner authority after Meta returns before enabling the Page', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encrypted = await encryptSecret('page-access-token-revoked', encryptionKey);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES ('authority-race', ?, 'user-1', 'merchant-1', '123456789',
                'pages_ready', ?, ?, unixepoch() + 3600, unixepoch())
    `).run(
      'f'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates (
        session_id, page_id, name, access_token_encrypted, tasks_json
      ) VALUES ('authority-race', '704', 'Authority Page', ?, '["MESSAGING"]')
    `).run(encrypted);
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        sqlite.exec(`
          UPDATE merchant_memberships SET status = 'revoked'
          WHERE user_id = 'user-1' AND merchant_id = 'merchant-1'
        `);
      }
      return Response.json({ success: true });
    }));

    const response = await authenticated.request('https://api.example.com/pages/704/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableAiMessaging: true }),
    }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FACEBOOK_APPROVAL_AUTHORITY_LOST' },
    });
    expect(methods).toEqual(['POST', 'DELETE']);
    expect(sqlite.prepare(`
      SELECT meta_subscription_status, meta_subscription_desired,
             ai_messaging_enabled, ai_messaging_approved_at,
             ai_messaging_approved_by_user_id
      FROM store_pages WHERE id = '704'
    `).get()).toEqual({
      meta_subscription_status: 'disconnected',
      meta_subscription_desired: 0,
      ai_messaging_enabled: 0,
      ai_messaging_approved_at: null,
      ai_messaging_approved_by_user_id: null,
    });
  });

  it('atomically enforces the free-plan Page limit during concurrent approvals', async () => {
    const { sqlite, env, authenticated } = fixture();
    const encryptedOne = await encryptSecret('page-access-token-one', encryptionKey);
    const encryptedTwo = await encryptSecret('page-access-token-two', encryptionKey);
    sqlite.prepare(`
      INSERT INTO meta_onboarding_sessions (
        id, state_digest, user_id, merchant_id, facebook_user_id, status,
        requested_permissions_json, granted_permissions_json, expires_at, consumed_at
      ) VALUES ('plan-race', ?, 'user-1', 'merchant-1', '123456789',
                'pages_ready', ?, ?, unixepoch() + 3600, unixepoch())
    `).run(
      '1'.repeat(64),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
      JSON.stringify(FACEBOOK_PAGE_PERMISSIONS),
    );
    sqlite.prepare(`
      INSERT INTO meta_page_candidates
        (session_id, page_id, name, access_token_encrypted, tasks_json)
      VALUES ('plan-race', '705', 'First Page', ?, '["MESSAGE"]'),
             ('plan-race', '706', 'Second Page', ?, '["MESSAGE"]')
    `).run(encryptedOne, encryptedTwo);

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchMock = vi.fn(async () => {
      markFirstStarted();
      await firstGate;
      return Response.json({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstApproval = authenticated.request(
      'https://api.example.com/pages/705/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableAiMessaging: false }),
      },
      env,
    );
    await firstStarted;
    const second = await authenticated.request(
      'https://api.example.com/pages/706/approve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableAiMessaging: false }),
      },
      env,
    );
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'FACEBOOK_PAGE_LIMIT_REACHED' },
    });
    releaseFirst();
    expect((await firstApproval).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM store_pages
      WHERE merchant_id = 'merchant-1'
        AND meta_subscription_status NOT IN ('not_subscribed', 'disconnected')
    `).get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT id FROM store_pages WHERE id = '706'").get())
      .toBeUndefined();
  });
});

describe('Facebook messaging enforcement', () => {
  it('fails the Page closed when Meta rejects its credential', async () => {
    const { sqlite, env } = fixture();
    const encrypted = await encryptSecret('page-access-token-revoked-123456', encryptionKey);
    sqlite.prepare(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token,
        meta_subscription_status, meta_permissions_json, meta_tasks_json,
        messaging_ready_at, ai_messaging_enabled, ai_messaging_approved_at,
        ai_messaging_approved_by_user_id, meta_subscription_desired
      ) VALUES ('776', 'merchant-1', 'Revoked Page', ?, 'subscribed', ?,
                '["MESSAGING"]', unixepoch(), 1, unixepoch(), 'user-1', 1)
    `).run(encrypted, JSON.stringify(FACEBOOK_PAGE_PERMISSIONS));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 190, message: 'sensitive provider detail' },
    }, { status: 401 })));

    await expect(sendAiReply(env, 'merchant-1', '776', 'customer', 'hello'))
      .rejects.toThrow('FACEBOOK_PAGE_CREDENTIAL_REJECTED');
    expect(sqlite.prepare(`
      SELECT meta_subscription_status, messaging_ready_at, ai_messaging_enabled,
             meta_last_error, meta_reconcile_after
      FROM store_pages WHERE id = '776'
    `).get()).toEqual({
      meta_subscription_status: 'subscription_failed',
      messaging_ready_at: null,
      ai_messaging_enabled: 0,
      meta_last_error: 'FACEBOOK_PAGE_CREDENTIAL_REJECTED',
      meta_reconcile_after: null,
    });
  });

  it('does not let global flags or a legacy global token bypass Page approval', async () => {
    const { sqlite, env } = fixture();
    env.META_PAGE_ACCESS_TOKEN = 'legacy-global-page-token';
    const encrypted = await encryptSecret('page-access-token-123456789', encryptionKey);
    sqlite.prepare(`
      INSERT INTO store_pages (
        id, merchant_id, name, meta_page_access_token,
        meta_subscription_status, meta_permissions_json, meta_tasks_json,
        messaging_ready_at, ai_messaging_enabled
      ) VALUES ('777', 'merchant-1', 'Page', ?, 'subscribed', ?, '["MESSAGING"]',
                unixepoch(), 0)
    `).run(encrypted, JSON.stringify(FACEBOOK_PAGE_PERMISSIONS));
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendAiReply(env, 'merchant-1', '777', 'customer', 'hello')).resolves.toBe(false);
    await expect(sendProactiveOrderUpdate(env, 'merchant-1', '777', 'customer', 'update')).resolves.toBe(false);
    await expect(passThreadToHuman(env, 'merchant-1', '777', 'customer', 'handoff')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    sqlite.exec(`
      UPDATE store_pages SET ai_messaging_enabled = 1,
        ai_messaging_approved_at = unixepoch(),
        ai_messaging_approved_by_user_id = 'user-1'
      WHERE id = '777'
    `);
    env.AI_ENABLED = 'false';
    await expect(sendAiReply(env, 'merchant-1', '777', 'customer', 'hello')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    env.AI_ENABLED = 'true';
    await expect(sendAiReply(env, 'merchant-1', '777', 'customer', 'hello')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(sendAiReply(env, 'merchant-2', '777', 'customer', 'hello')).resolves.toBe(false);
    sqlite.exec("UPDATE merchants SET status = 'suspended' WHERE id = 'merchant-1'");
    await expect(sendAiReply(env, 'merchant-1', '777', 'customer', 'hello')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sqlite.exec("UPDATE merchants SET status = 'active' WHERE id = 'merchant-1'");
    env.MESSAGING_ENABLED = 'false';
    await expect(sendAiReply(env, 'merchant-1', '777', 'customer', 'hello')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops ordinary disabled-Page jobs before the customer thread but keeps handovers', async () => {
    const { sqlite, env } = fixture();
    sqlite.exec(`
      INSERT INTO store_pages (id, merchant_id, name)
      VALUES ('888', 'merchant-1', 'Disabled Page');
    `);
    const threadFetch = vi.fn(async () => Response.json({ ok: true }));
    env.CUSTOMER_THREADS = {
      idFromName: vi.fn(() => ({ toString: () => 'thread-id' })),
      get: vi.fn(() => ({ fetch: threadFetch })),
    } as unknown as DurableObjectNamespace;

    function message(body: MetaQueueJob) {
      return {
        body,
        ack: vi.fn(),
        retry: vi.fn(),
      };
    }
    const ordinary = message({
      type: 'meta.webhook',
      eventId: 'ordinary-event',
      payload: {
        object: 'page',
        entry: [{
          id: '888',
          messaging: [{
            sender: { id: 'customer-1' },
            message: { mid: 'message-1', text: 'Hello' },
          }],
        }],
      },
    });
    await consumeQueue(
      { messages: [ordinary] } as unknown as MessageBatch<QueueJob>,
      env,
    );
    expect(threadFetch).not.toHaveBeenCalled();
    expect(ordinary.ack).toHaveBeenCalledOnce();

    const handover = message({
      type: 'meta.webhook',
      eventId: 'handover-event',
      payload: {
        object: 'page',
        entry: [{
          id: '888',
          messaging: [{
            sender: { id: 'customer-1' },
            pass_thread_control: {},
          }],
        }],
      },
    });
    await consumeQueue(
      { messages: [handover] } as unknown as MessageBatch<QueueJob>,
      env,
    );
    expect(threadFetch).toHaveBeenCalledOnce();
    expect(handover.ack).toHaveBeenCalledOnce();
  });

  it('keeps the pre-generation automation gate closed after queue handoff', async () => {
    const { sqlite, env } = fixture();
    sqlite.exec(`
      INSERT INTO store_pages (id, merchant_id, name)
      VALUES ('999', 'merchant-1', 'Paused Page');
    `);
    await expect(isPageAiAutomationActive(env, 'merchant-1', '999')).resolves.toBe(false);
    env.MESSAGING_ENABLED = 'false';
    await expect(isPageAiAutomationActive(env, 'merchant-1', '999')).resolves.toBe(false);
  });
});
