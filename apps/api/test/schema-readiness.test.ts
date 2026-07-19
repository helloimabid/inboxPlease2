import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { isSchemaReady } from '../src/config';
import type { AppEnv, Bindings } from '../src/env';
import { errorResponse } from '../src/errors';
import { healthRoutes } from '../src/routes/health';
import { assertReadySchema, requireReadySchema } from '../src/schema-readiness';

function healthyDb() {
  return {
    prepare: () => ({ first: async () => ({ healthy: 1 }) }),
  } as unknown as D1Database;
}

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: healthyDb(),
    ENVIRONMENT: 'production',
    DEV_MODE: 'false',
    D1_SCHEMA_READY: 'false',
    AUTH_SECRET: 'schema-gate-test-secret-at-least-thirty-two-bytes',
    ...overrides,
  } as Bindings;
}

describe('D1 schema readiness gate', () => {
  it('requires an exact production opt-in but permits explicit local development', () => {
    expect(isSchemaReady(env())).toBe(false);
    expect(isSchemaReady(env({ D1_SCHEMA_READY: 'TRUE' }))).toBe(false);
    expect(isSchemaReady(env({ D1_SCHEMA_READY: 'true' }))).toBe(true);
    expect(isSchemaReady(env({
      ENVIRONMENT: 'local', DEV_MODE: 'true',
    }))).toBe(true);
  });

  it('reports blocked health and rejects production HTTP requests while false', async () => {
    const blockedEnv = env();
    const app = new Hono<AppEnv>()
      .use('*', requireReadySchema)
      .route('/health', healthRoutes)
      .post('/database-work', (c) => c.json({ ok: true }));
    app.onError((error, c) => errorResponse(c, error));
    const health = await app.request('http://localhost/health', {}, blockedEnv);
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({
      ok: false,
      checks: { database: 'ok', schema: 'blocked' },
    });

    const auth = await app.request('http://localhost/database-work', {
      method: 'POST',
    }, blockedEnv);
    expect(auth.status).toBe(503);
    await expect(auth.json()).resolves.toMatchObject({
      error: { code: 'D1_SCHEMA_NOT_READY' },
    });
  });

  it('blocks background database work while production schema is false', () => {
    const blockedEnv = env();
    expect(() => assertReadySchema(blockedEnv)).toThrow(/schema is not ready/i);
    expect(() => assertReadySchema(env({ D1_SCHEMA_READY: 'true' }))).not.toThrow();
  });
});
