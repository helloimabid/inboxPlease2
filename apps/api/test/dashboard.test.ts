import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv, Bindings } from '../src/env';
import { dashboardRoutes } from '../src/routes/dashboard';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];

function dashboardFixture() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Dashboard Shop');
    INSERT INTO store_pages (id, merchant_id, name)
    VALUES ('page-1', 'merchant-1', 'Shop Page');
  `);
  const env = { DB: d1FromSqlite(sqlite) } as unknown as Bindings;
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('auth', {
        subject: 'user-1',
        merchantId: 'merchant-1',
        role: 'owner',
        source: 'session',
      });
      c.set('requestId', 'request-1');
      await next();
    })
    .route('/', dashboardRoutes);
  return { sqlite, env, app };
}

async function summary(fixture: ReturnType<typeof dashboardFixture>) {
  const response = await fixture.app.request('http://localhost/', {}, fixture.env);
  expect(response.status).toBe(200);
  return response.json<{
    data: {
      catalog: { total: number; active: number; outOfStock: number };
      usage: Array<{ month: string; aiMessages: number; visionMessages: number }>;
    };
  }>();
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('dashboard summary truth semantics', () => {
  it('does not count archived-only products as usable catalog setup', async () => {
    const fixture = dashboardFixture();
    fixture.sqlite.exec(`
      INSERT INTO products (
        id, merchant_id, page_id, sku, name, price_minor, stock, status
      ) VALUES (
        'archived-1', 'merchant-1', 'page-1', 'ARCH-1', 'Old product', 10000, 2, 'archived'
      );
    `);
    const body = await summary(fixture);
    expect(body.data.catalog).toEqual({ total: 0, active: 0, outOfStock: 0 });
  });

  it('counts active and draft products while excluding archived products', async () => {
    const fixture = dashboardFixture();
    fixture.sqlite.exec(`
      INSERT INTO products (id, merchant_id, page_id, sku, name, price_minor, stock, status)
      VALUES
        ('active-1', 'merchant-1', 'page-1', 'ACTIVE', 'Active', 10000, 0, 'active'),
        ('draft-1', 'merchant-1', 'page-1', 'DRAFT', 'Draft', 10000, 3, 'draft'),
        ('archived-1', 'merchant-1', 'page-1', 'ARCH', 'Archived', 10000, 3, 'archived');
    `);
    const body = await summary(fixture);
    expect(body.data.catalog).toEqual({ total: 2, active: 1, outOfStock: 1 });
  });

  it('always returns exactly the current UTC month, defaulting absent usage to zero', async () => {
    const fixture = dashboardFixture();
    fixture.sqlite.exec(`
      INSERT INTO monthly_usage (merchant_id, month, ai_messages, vision_messages)
      VALUES ('merchant-1', '2000-01', 900, 90);
    `);
    const currentMonth = new Date().toISOString().slice(0, 7);
    let body = await summary(fixture);
    expect(body.data.usage).toEqual([{
      month: currentMonth, aiMessages: 0, visionMessages: 0,
    }]);

    fixture.sqlite.prepare(`
      INSERT INTO monthly_usage (merchant_id, month, ai_messages, vision_messages)
      VALUES (?, ?, ?, ?)
    `).run('merchant-1', currentMonth, 12, 3);
    body = await summary(fixture);
    expect(body.data.usage).toEqual([{
      month: currentMonth, aiMessages: 12, visionMessages: 3,
    }]);
  });
});
