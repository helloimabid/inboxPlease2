import { Hono } from 'hono';
import { assertProductOwned } from '../db';
import type { AppEnv } from '../env';
import { ApiError, jsonOk } from '../errors';
import { BodyTooLargeError, readBodyBounded } from '../bounded-body';
import { MERCHANT_ADMIN_ROLES, requireRole } from '../auth';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectImageContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const mediaRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    await next();
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
  })
  .put('/products/:productId', requireRole(...MERCHANT_ADMIN_ROLES), async (c) => {
    const { merchantId } = c.get('auth');
    const productId = c.req.param('productId');
    await assertProductOwned(c.env.DB, merchantId, productId);
    const variantId = c.req.query('variantId')?.trim() || null;
    const role = c.req.query('role')?.trim() || 'primary';
    if (role !== 'primary' && role !== 'gallery') {
      throw new ApiError(422, 'INVALID_MEDIA_ROLE', 'Media role must be primary or gallery');
    }
    if (variantId) {
      const variant = await c.env.DB.prepare(
        `SELECT id FROM product_variants
         WHERE id = ?1 AND product_id = ?2 AND merchant_id = ?3`,
      ).bind(variantId, productId, merchantId).first<{ id: string }>();
      if (!variant) throw new ApiError(404, 'VARIANT_NOT_FOUND', 'Variant was not found');
    }
    const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
    if (!allowedTypes.has(contentType)) {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG, WebP, and GIF images are accepted');
    }
    const declaredLength = Number(c.req.header('Content-Length') ?? 0);
    if (declaredLength > MAX_MEDIA_BYTES) {
      throw new ApiError(413, 'MEDIA_TOO_LARGE', 'Media must not exceed 10 MiB');
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await readBodyBounded(c.req.raw.body, MAX_MEDIA_BYTES, declaredLength);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new ApiError(413, 'MEDIA_TOO_LARGE', 'Media must not exceed 10 MiB');
      }
      throw error;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new ApiError(413, 'MEDIA_TOO_LARGE', 'Media must be between 1 byte and 10 MiB');
    }
    const detectedType = detectImageContentType(new Uint8Array(bytes));
    if (detectedType !== contentType) {
      throw new ApiError(
        415,
        'MEDIA_TYPE_MISMATCH',
        'The uploaded bytes do not match the declared image type',
      );
    }
    const assetId = crypto.randomUUID();
    const extension = contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1] ?? 'bin';
    const r2Key = `catalog/${merchantId}/${productId}/${variantId ?? 'product'}/${assetId}.${extension}`;
    await c.env.MEDIA.put(r2Key, bytes, {
      httpMetadata: { contentType, cacheControl: 'private, max-age=3600' },
      customMetadata: {
        merchant_id: merchantId,
        product_id: productId,
        asset_id: assetId,
        role,
        ...(variantId ? { variant_id: variantId } : {}),
      },
    });
    const replaced = role === 'primary'
      ? await c.env.DB.prepare(
          `SELECT id, r2_key FROM media_assets
           WHERE merchant_id = ?1 AND product_id = ?2 AND role = 'primary'
             AND ((?3 IS NULL AND variant_id IS NULL) OR variant_id = ?3)`,
        ).bind(merchantId, productId, variantId).first<{ id: string; r2_key: string }>()
      : null;
    try {
      await c.env.DB.batch([
        ...(replaced ? [c.env.DB.prepare(
          'DELETE FROM media_assets WHERE id = ?1 AND merchant_id = ?2',
        ).bind(replaced.id, merchantId)] : []),
        c.env.DB.prepare(
          `INSERT INTO media_assets
             (id, merchant_id, product_id, r2_key, content_type, byte_size, variant_id, role)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(
          assetId, merchantId, productId, r2Key, contentType, bytes.byteLength,
          variantId, role,
        ),
      ]);
    } catch (error) {
      await c.env.MEDIA.delete(r2Key);
      throw error;
    }
    if (replaced) c.executionCtx.waitUntil(c.env.MEDIA.delete(replaced.r2_key));
    return jsonOk(c, {
      id: assetId,
      productId,
      variantId,
      role,
      contentType,
      byteSize: bytes.byteLength,
    }, 201);
  })
  .get('/:assetId', async (c) => {
    const { merchantId } = c.get('auth');
    const assetId = c.req.param('assetId');
    const asset = await c.env.DB.prepare(
      `SELECT r2_key, content_type FROM media_assets WHERE id = ?1 AND merchant_id = ?2`,
    ).bind(assetId, merchantId).first<{ r2_key: string; content_type: string }>();
    if (!asset) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media asset was not found');
    const object = await c.env.MEDIA.get(asset.r2_key);
    if (!object || !('body' in object)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media object was not found');
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', asset.content_type);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'private, max-age=3600');
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return new Response(object.body, { headers });
  })
  .delete('/:assetId', requireRole(...MERCHANT_ADMIN_ROLES), async (c) => {
    const { merchantId } = c.get('auth');
    const assetId = c.req.param('assetId');
    const asset = await c.env.DB.prepare(
      'SELECT r2_key FROM media_assets WHERE id = ?1 AND merchant_id = ?2',
    ).bind(assetId, merchantId).first<{ r2_key: string }>();
    if (!asset) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media asset was not found');
    await c.env.DB.prepare(
      'DELETE FROM media_assets WHERE id = ?1 AND merchant_id = ?2',
    ).bind(assetId, merchantId).run();
    c.executionCtx.waitUntil(c.env.MEDIA.delete(asset.r2_key));
    return jsonOk(c, { deleted: true });
  });
