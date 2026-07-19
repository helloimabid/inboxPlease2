import { ApiError } from './errors';
import type { Bindings } from './env';
import { sha256Name } from './security';

export interface PageRow {
  id: string;
  merchant_id: string;
  name: string;
  meta_page_access_token: string | null;
}

export interface ProductRow {
  id: string;
  merchant_id: string;
  page_id: string;
  sku: string;
  name: string;
  description: string;
  price_minor: number;
  currency: string;
  stock: number;
  status: 'active' | 'draft' | 'archived';
  created_at: number;
  updated_at: number;
}

export interface ProductVariantRow {
  id: string;
  merchant_id: string;
  product_id: string;
  sku: string;
  name: string;
  price_minor: number;
  stock: number;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface OrderRow {
  id: string;
  merchant_id: string;
  page_id: string;
  customer_psid: string;
  status: string;
  payment_status: string;
  payment_transaction_id: string | null;
  total_minor: number;
  currency: string;
  shipping_address_json: string;
  created_at: number;
  updated_at: number;
}

export async function assertPageOwned(
  db: D1Database,
  merchantId: string,
  requestedPageId: string,
): Promise<PageRow> {
  const page = await db.prepare(
    `SELECT id, merchant_id, name, meta_page_access_token
     FROM store_pages WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(requestedPageId, merchantId).first<PageRow>();
  if (!page) throw new ApiError(404, 'PAGE_NOT_FOUND', 'Page was not found');
  return page;
}

export async function assertProductOwned(
  db: D1Database,
  merchantId: string,
  productId: string,
): Promise<ProductRow> {
  const product = await db.prepare(
    `SELECT id, merchant_id, page_id, sku, name, description, price_minor,
            currency, stock, status, created_at, updated_at
     FROM products WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(productId, merchantId).first<ProductRow>();
  if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product was not found');
  return product;
}

export async function insertWebhookOnce(
  db: D1Database,
  provider: 'meta' | 'sslcommerz',
  eventId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO webhook_events (provider, event_id, status)
     VALUES (?1, ?2, 'received')`,
  ).bind(provider, eventId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markWebhook(
  db: D1Database,
  provider: 'meta' | 'sslcommerz',
  eventId: string,
  status: 'processing' | 'processed' | 'ignored' | 'failed',
  error?: string,
): Promise<void> {
  await db.prepare(
    `UPDATE webhook_events
     SET status = ?3,
         attempts = attempts + 1,
         processed_at = CASE WHEN ?3 IN ('processed', 'ignored') THEN unixepoch() ELSE processed_at END,
         last_error = ?4
     WHERE provider = ?1 AND event_id = ?2`,
  ).bind(provider, eventId, status, error ?? null).run();
}

export async function stableEventId(parts: readonly string[]): Promise<string> {
  return sha256Name(['event', ...parts]);
}

export async function ensureLocalPage(
  env: Bindings,
  merchantId: string,
  requestedPageId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO store_pages (id, merchant_id, name, connected_at)
     VALUES (?1, ?2, 'Local development page', unixepoch())`,
  ).bind(requestedPageId, merchantId).run();
}
