import { Hono } from 'hono';
import { isSchemaReady } from '../config';
import type { AppEnv } from '../env';

export const healthRoutes = new Hono<AppEnv>().get('/', async (c) => {
  let database: 'ok' | 'error' = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1 AS healthy').first();
  } catch (error) {
    database = 'error';
    console.error('Health check failed', error);
  }
  const schema: 'ok' | 'blocked' = isSchemaReady(c.env) ? 'ok' : 'blocked';
  const healthy = database === 'ok' && schema === 'ok';
  return c.json({
    ok: healthy,
    service: 'inboxplease-api',
    environment: c.env.ENVIRONMENT ?? 'local',
    checks: { database, schema },
    timestamp: new Date().toISOString(),
  }, healthy ? 200 : 503);
});
