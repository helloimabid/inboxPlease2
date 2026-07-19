import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { isDevelopment } from '../config';
import {
  assertPageOwned,
  assertProductOwned,
  ensureLocalPage,
  type ProductRow,
  type ProductVariantRow,
} from '../db';
import type { AppEnv, CatalogQueueJob } from '../env';
import { ApiError, jsonOk } from '../errors';
import { dispatchOutboxAfterCommit, prepareOutboxInsert } from '../outbox';
import {
  createProductSchema,
  productQuerySchema,
  updateProductSchema,
} from '../schemas';
import { validationHook } from '../validation';
import { MERCHANT_ADMIN_ROLES, requireRole } from '../auth';

interface MediaRow {
  id: string;
  product_id: string;
  variant_id: string | null;
}

interface CatalogDetails {
  variants: Map<string, ProductVariantRow[]>;
  productImages: Map<string, MediaRow>;
  variantImages: Map<string, MediaRow>;
}

function productJson(row: ProductRow, details?: CatalogDetails) {
  const variants = details?.variants.get(row.id) ?? [];
  const productImage = details?.productImages.get(row.id);
  return {
    id: row.id,
    pageId: row.page_id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    priceMinor: row.price_minor,
    currency: row.currency,
    stock: row.stock,
    status: row.status,
    image: productImage ? { id: productImage.id } : null,
    variants: variants.map((variant) => {
      const image = details?.variantImages.get(variant.id);
      return {
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        priceMinor: variant.price_minor,
        stock: variant.stock,
        position: variant.position,
        image: image ? { id: image.id } : null,
      };
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadCatalogDetails(
  db: D1Database,
  merchantId: string,
  productIds: readonly string[],
): Promise<CatalogDetails> {
  const details: CatalogDetails = {
    variants: new Map(),
    productImages: new Map(),
    variantImages: new Map(),
  };
  if (productIds.length === 0) return details;
  const placeholders = productIds.map((_, index) => `?${index + 2}`).join(', ');
  const [variantResult, mediaResult] = await Promise.all([
    db.prepare(
      `SELECT id, merchant_id, product_id, sku, name, price_minor, stock,
              position, created_at, updated_at
       FROM product_variants
       WHERE merchant_id = ?1 AND product_id IN (${placeholders})
       ORDER BY product_id, position, created_at`,
    ).bind(merchantId, ...productIds).all<ProductVariantRow>(),
    db.prepare(
      `SELECT id, product_id, variant_id
       FROM media_assets
       WHERE merchant_id = ?1 AND product_id IN (${placeholders}) AND role = 'primary'
       ORDER BY created_at DESC`,
    ).bind(merchantId, ...productIds).all<MediaRow>(),
  ]);
  for (const variant of variantResult.results) {
    const items = details.variants.get(variant.product_id) ?? [];
    items.push(variant);
    details.variants.set(variant.product_id, items);
  }
  for (const asset of mediaResult.results) {
    if (asset.variant_id) {
      if (!details.variantImages.has(asset.variant_id)) details.variantImages.set(asset.variant_id, asset);
    } else if (!details.productImages.has(asset.product_id)) {
      details.productImages.set(asset.product_id, asset);
    }
  }
  return details;
}

function validateVariantSkus(variants: ReadonlyArray<{ sku: string }>) {
  const seen = new Set<string>();
  for (const variant of variants) {
    const normalized = variant.sku.toLocaleLowerCase('en-US');
    if (seen.has(normalized)) {
      throw new ApiError(409, 'VARIANT_SKU_CONFLICT', 'Variant SKUs must be unique within a product');
    }
    seen.add(normalized);
  }
}

export function productSearchQuery(input: string): string {
  return input
    .normalize('NFKC')
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 8)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(' AND ');
}

async function enforceProductLimit(env: AppEnv['Bindings'], merchantId: string) {
  const merchant = await env.DB.prepare(
    'SELECT plan FROM merchants WHERE id = ?1 AND status = \'active\'',
  ).bind(merchantId).first<{ plan: string }>();
  if (!merchant) throw new ApiError(403, 'MERCHANT_INACTIVE', 'Merchant is not active');
  const limit = merchant.plan === 'free' ? 10 : merchant.plan === 'pro' ? 100 : Infinity;
  if (Number.isFinite(limit)) {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM products
       WHERE merchant_id = ?1 AND status <> 'archived'`,
    ).bind(merchantId).first<{ count: number }>();
    if ((count?.count ?? 0) >= limit) {
      throw new ApiError(409, 'PRODUCT_LIMIT_REACHED', 'Product limit reached for this plan');
    }
  }
}

export const catalogRoutes = new Hono<AppEnv>()
  .get('/', zValidator('query', productQuerySchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const query = c.req.valid('query');
    const where = ['merchant_id = ?1'];
    const parameters: Array<string | number> = [merchantId];
    if (query.pageId) {
      parameters.push(query.pageId);
      where.push(`page_id = ?${parameters.length}`);
    }
    if (query.status) {
      parameters.push(query.status);
      where.push(`status = ?${parameters.length}`);
    }
    if (query.q) {
      parameters.push(productSearchQuery(query.q));
      where.push(
        `id IN (
          SELECT product_id FROM products_fts
          WHERE products_fts MATCH ?${parameters.length}
        )`,
      );
    }
    parameters.push(query.limit, query.offset);
    const result = await c.env.DB.prepare(
      `SELECT id, merchant_id, page_id, sku, name, description, price_minor,
              currency, stock, status, created_at, updated_at
       FROM products WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC LIMIT ?${parameters.length - 1} OFFSET ?${parameters.length}`,
    ).bind(...parameters).all<ProductRow>();
    const details = await loadCatalogDetails(c.env.DB, merchantId, result.results.map(({ id }) => id));
    return jsonOk(c, {
      items: result.results.map((row) => productJson(row, details)),
      pagination: { limit: query.limit, offset: query.offset },
    });
  })
  .post('/', requireRole(...MERCHANT_ADMIN_ROLES), zValidator('json', createProductSchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const input = c.req.valid('json');
    if (isDevelopment(c.env)) await ensureLocalPage(c.env, merchantId, input.pageId);
    await assertPageOwned(c.env.DB, merchantId, input.pageId);
    if (input.status !== 'archived') await enforceProductLimit(c.env, merchantId);
    const id = crypto.randomUUID();
    validateVariantSkus(input.variants);
    const variants = input.variants.map((variant, position) => ({
      ...variant,
      id: crypto.randomUUID(),
      position,
    }));
    const stock = variants.length
      ? variants.reduce((total, variant) => total + variant.stock, 0)
      : input.stock;
    const job: CatalogQueueJob = {
      type: 'catalog.reindex',
      eventId: crypto.randomUUID(),
      merchantId,
      pageId: input.pageId,
      productId: id,
      operation: 'upsert',
    };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO products
             (id, merchant_id, page_id, sku, name, description, price_minor, currency, stock, status)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        ).bind(
          id, merchantId, input.pageId, input.sku, input.name, input.description,
          input.priceMinor, input.currency, stock, input.status,
        ),
        ...variants.map((variant) => c.env.DB.prepare(
          `INSERT INTO product_variants
             (id, merchant_id, product_id, sku, name, price_minor, stock, position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(
          variant.id, merchantId, id, variant.sku, variant.name,
          variant.priceMinor, variant.stock, variant.position,
        )),
        prepareOutboxInsert(c.env.DB, job),
      ]);
    } catch (error) {
      if (String(error).toLowerCase().includes('product limit reached')) {
        throw new ApiError(409, 'PRODUCT_LIMIT_REACHED', 'Product limit reached for this plan');
      }
      if (String(error).includes('UNIQUE')) {
        throw new ApiError(409, 'SKU_CONFLICT', 'SKU already exists for this merchant');
      }
      throw error;
    }
    c.executionCtx.waitUntil(dispatchOutboxAfterCommit(c.env, job.eventId));
    const product = await assertProductOwned(c.env.DB, merchantId, id);
    const details = await loadCatalogDetails(c.env.DB, merchantId, [id]);
    return jsonOk(c, productJson(product, details), 201);
  })
  .put('/:productId', requireRole(...MERCHANT_ADMIN_ROLES), zValidator('json', updateProductSchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const productId = c.req.param('productId');
    const input = c.req.valid('json');
    const current = await assertProductOwned(c.env.DB, merchantId, productId);
    const existing = await c.env.DB.prepare(
      `SELECT id, merchant_id, product_id, sku, name, price_minor, stock,
              position, created_at, updated_at
       FROM product_variants WHERE merchant_id = ?1 AND product_id = ?2`,
    ).bind(merchantId, productId).all<ProductVariantRow>();
    const existingById = new Map(existing.results.map((variant) => [variant.id, variant]));
    const incomingVariants = input.variants?.map((variant, position) => ({
      ...variant,
      id: variant.id ?? crypto.randomUUID(),
      position,
    }));
    if (incomingVariants) {
      validateVariantSkus(incomingVariants);
      const incomingIds = new Set<string>();
      for (const variant of incomingVariants) {
        if (incomingIds.has(variant.id)) {
          throw new ApiError(409, 'VARIANT_ID_CONFLICT', 'A variant cannot be submitted more than once');
        }
        incomingIds.add(variant.id);
        if (variant.id && input.variants?.some((item) => item.id === variant.id) && !existingById.has(variant.id)) {
          throw new ApiError(404, 'VARIANT_NOT_FOUND', 'A submitted variant does not belong to this product');
        }
      }
    }
    const removedVariants = incomingVariants
      ? existing.results.filter((variant) => !incomingVariants.some(({ id }) => id === variant.id))
      : [];
    const removedMedia = removedVariants.length
      ? await c.env.DB.prepare(
          `SELECT r2_key FROM media_assets
           WHERE merchant_id = ?1 AND variant_id IN (${removedVariants.map((_, index) => `?${index + 2}`).join(', ')})`,
        ).bind(merchantId, ...removedVariants.map(({ id }) => id)).all<{ r2_key: string }>()
      : { results: [] as Array<{ r2_key: string }> };
    const nextStock = incomingVariants
      ? incomingVariants.reduce((total, variant) => total + variant.stock, 0)
      : input.stock ?? current.stock;
    const job: CatalogQueueJob = {
      type: 'catalog.reindex',
      eventId: crypto.randomUUID(),
      merchantId,
      pageId: current.page_id,
      productId,
      operation: 'upsert',
    };
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE products SET
             sku = COALESCE(?3, sku),
             name = COALESCE(?4, name),
             description = COALESCE(?5, description),
             price_minor = COALESCE(?6, price_minor),
             currency = COALESCE(?7, currency),
             stock = ?8,
             status = COALESCE(?9, status),
             updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2`,
        ).bind(
          productId,
          merchantId,
          input.sku ?? null,
          input.name ?? null,
          input.description ?? null,
          input.priceMinor ?? null,
          input.currency ?? null,
          nextStock,
          input.status ?? null,
        ),
        ...(incomingVariants ?? []).map((variant) => existingById.has(variant.id)
          ? c.env.DB.prepare(
              `UPDATE product_variants SET sku = ?4, name = ?5, price_minor = ?6,
                 stock = ?7, position = ?8, updated_at = unixepoch()
               WHERE id = ?1 AND merchant_id = ?2 AND product_id = ?3`,
            ).bind(
              variant.id, merchantId, productId, variant.sku, variant.name,
              variant.priceMinor, variant.stock, variant.position,
            )
          : c.env.DB.prepare(
              `INSERT INTO product_variants
                 (id, merchant_id, product_id, sku, name, price_minor, stock, position)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
            ).bind(
              variant.id, merchantId, productId, variant.sku, variant.name,
              variant.priceMinor, variant.stock, variant.position,
            )),
        ...removedVariants.map((variant) => c.env.DB.prepare(
          'DELETE FROM product_variants WHERE id = ?1 AND merchant_id = ?2 AND product_id = ?3',
        ).bind(variant.id, merchantId, productId)),
        prepareOutboxInsert(c.env.DB, job),
      ]);
    } catch (error) {
      if (String(error).toLowerCase().includes('product limit reached')) {
        throw new ApiError(409, 'PRODUCT_LIMIT_REACHED', 'Product limit reached for this plan');
      }
      if (String(error).includes('UNIQUE')) {
        throw new ApiError(409, 'SKU_CONFLICT', 'SKU already exists for this merchant');
      }
      throw error;
    }
    c.executionCtx.waitUntil(Promise.all([
      dispatchOutboxAfterCommit(c.env, job.eventId),
      ...removedMedia.results.map(({ r2_key: key }) => c.env.MEDIA.delete(key)),
    ]).then(() => undefined));
    const updated = await assertProductOwned(c.env.DB, merchantId, productId);
    const details = await loadCatalogDetails(c.env.DB, merchantId, [productId]);
    return jsonOk(c, productJson(updated, details));
  })
  .delete('/:productId', requireRole(...MERCHANT_ADMIN_ROLES), async (c) => {
    const { merchantId } = c.get('auth');
    const productId = c.req.param('productId');
    const current = await assertProductOwned(c.env.DB, merchantId, productId);
    // Products referenced by historical orders are immutable records. Archive
    // them and remove them from live caches/search instead of deleting their R2
    // media first and then failing an ON DELETE RESTRICT constraint.
    const job: CatalogQueueJob = {
      type: 'catalog.reindex',
      eventId: crypto.randomUUID(),
      merchantId,
      pageId: current.page_id,
      productId,
      operation: 'delete',
    };
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE products SET status = 'archived', updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2`,
      ).bind(productId, merchantId),
      prepareOutboxInsert(c.env.DB, job),
    ]);
    c.executionCtx.waitUntil(dispatchOutboxAfterCommit(c.env, job.eventId));
    return jsonOk(c, { archived: true });
  });
