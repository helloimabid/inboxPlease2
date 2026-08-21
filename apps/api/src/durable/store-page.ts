import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../env';

interface TenantIdentity {
  merchantId: string;
  pageId: string;
}

export interface CachedProduct {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  stock: number;
  status: string;
  updatedAt: number;
}

type TenantRow = { merchant_id: string; page_id: string };

function readIdentity(value: unknown): TenantIdentity {
  if (!value || typeof value !== 'object') throw new Error('Missing tenant identity');
  const input = value as Record<string, unknown>;
  if (typeof input.merchantId !== 'string' || typeof input.pageId !== 'string') {
    throw new Error('Invalid tenant identity');
  }
  return { merchantId: input.merchantId, pageId: input.pageId };
}

export class StorePageDO extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenant_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        merchant_id TEXT NOT NULL,
        page_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_cache (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        price_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        stock INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_status_name
        ON catalog_cache(status, name);
      CREATE TABLE IF NOT EXISTS settings_cache (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Migrate existing catalog_cache tables that lack the image_id column.
    const hasImageId = this.ctx.storage.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('catalog_cache') WHERE name = 'image_id'",
      )
      .toArray()[0];
    if (!hasImageId || hasImageId.cnt === 0) {
      this.ctx.storage.sql.exec('ALTER TABLE catalog_cache ADD COLUMN image_id TEXT');
    }
  }

  private bindOrAssertTenant(identity: TenantIdentity): void {
    const existing = this.ctx.storage.sql
      .exec<TenantRow>('SELECT merchant_id, page_id FROM tenant_meta WHERE singleton = 1')
      .toArray()[0];
    if (!existing) {
      this.ctx.storage.sql.exec(
        'INSERT INTO tenant_meta (singleton, merchant_id, page_id) VALUES (1, ?1, ?2)',
        identity.merchantId,
        identity.pageId,
      );
      return;
    }
    if (existing.merchant_id !== identity.merchantId || existing.page_id !== identity.pageId) {
      throw new Error('Durable Object tenant identity mismatch');
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/bootstrap') {
        const identity = readIdentity(await request.json());
        this.bindOrAssertTenant(identity);
        return Response.json({ ok: true });
      }

      const body = request.method === 'GET'
        ? {
            merchantId: url.searchParams.get('merchantId'),
            pageId: url.searchParams.get('pageId'),
          }
        : await request.json<Record<string, unknown>>();
      const identity = readIdentity(body);
      this.bindOrAssertTenant(identity);

      if (request.method === 'PUT' && url.pathname === '/catalog') {
        const product = body.product;
        if (!product || typeof product !== 'object') throw new Error('Missing product');
        const item = product as Record<string, unknown>;
        if (
          typeof item.id !== 'string' || typeof item.sku !== 'string' ||
          typeof item.name !== 'string' || typeof item.description !== 'string' ||
          typeof item.priceMinor !== 'number' || typeof item.currency !== 'string' ||
          typeof item.stock !== 'number' || typeof item.status !== 'string'
        ) throw new Error('Invalid product cache payload');
        const imageId = typeof item.imageId === 'string' ? item.imageId : null;
        this.ctx.storage.sql.exec(
          `INSERT INTO catalog_cache
             (id, sku, name, description, price_minor, currency, stock, status, updated_at, image_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(id) DO UPDATE SET
             sku = excluded.sku, name = excluded.name, description = excluded.description,
             price_minor = excluded.price_minor, currency = excluded.currency,
             stock = excluded.stock, status = excluded.status, updated_at = excluded.updated_at,
             image_id = excluded.image_id`,
          item.id,
          item.sku,
          item.name,
          item.description,
          item.priceMinor,
          item.currency,
          item.stock,
          item.status,
          typeof item.updatedAt === 'number' ? item.updatedAt : Math.floor(Date.now() / 1000),
          imageId,
        );
        return Response.json({ ok: true });
      }

      if (request.method === 'DELETE' && url.pathname.startsWith('/catalog/')) {
        const productId = decodeURIComponent(url.pathname.slice('/catalog/'.length));
        this.ctx.storage.sql.exec('DELETE FROM catalog_cache WHERE id = ?1', productId);
        return Response.json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/catalog') {
        const products = this.ctx.storage.sql.exec<{
          id: string; sku: string; name: string; description: string;
          price_minor: number; currency: string; stock: number; status: string;
          updated_at: number; image_id: string | null;
        }>(
          `SELECT id, sku, name, description, price_minor, currency, stock, status, updated_at, image_id
           FROM catalog_cache WHERE status = 'active' ORDER BY updated_at DESC LIMIT 200`,
        ).toArray().map((row) => ({
          id: row.id,
          sku: row.sku,
          name: row.name,
          description: row.description,
          priceMinor: row.price_minor,
          currency: row.currency,
          stock: row.stock,
          status: row.status,
          updatedAt: row.updated_at,
          imageId: row.image_id,
        }));
        return Response.json({ ok: true, products });
      }

      if (request.method === 'PUT' && url.pathname === '/settings') {
        this.ctx.storage.sql.exec(
          `INSERT INTO settings_cache (singleton, payload_json, updated_at)
           VALUES (1, ?1, unixepoch())
           ON CONFLICT(singleton) DO UPDATE SET
             payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
          JSON.stringify(body.settings ?? {}),
        );
        return Response.json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/settings') {
        const row = this.ctx.storage.sql.exec<{ payload_json: string }>(
          'SELECT payload_json FROM settings_cache WHERE singleton = 1',
        ).toArray()[0];
        return Response.json({ ok: true, settings: row ? JSON.parse(row.payload_json) : {} });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('StorePageDO request failed', error);
      return Response.json({ ok: false, error: 'Invalid StorePageDO request' }, { status: 400 });
    }
  }
}
