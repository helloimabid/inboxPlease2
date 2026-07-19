import { afterEach, describe, expect, it } from 'vitest';
import { createProductSchema, updateProductSchema } from '../src/schemas';
import { migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];

function fixture() {
  const database = migratedDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Variant Shop');
    INSERT INTO merchants (id, name) VALUES ('merchant-2', 'Other Shop');
    INSERT INTO store_pages (id, merchant_id, name)
    VALUES ('page-1', 'merchant-1', 'Shop Page');
    INSERT INTO products (
      id, merchant_id, page_id, sku, name, price_minor, stock, status
    ) VALUES (
      'product-1', 'merchant-1', 'page-1', 'BASE-1', 'Product', 10000, 3, 'active'
    );
  `);
  return database;
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('catalog variants and images', () => {
  it('validates bounded variant input on create and update', () => {
    expect(createProductSchema.parse({
      pageId: 'page-1',
      sku: 'BASE-1',
      name: 'Product',
      priceMinor: 10000,
      variants: [{ sku: 'BLUE-L', name: 'Blue / Large', priceMinor: 11000, stock: 2 }],
    }).variants).toHaveLength(1);
    expect(updateProductSchema.safeParse({ variants: [] }).success).toBe(true);
    expect(createProductSchema.safeParse({
      pageId: 'page-1',
      sku: 'BASE-1',
      name: 'Product',
      priceMinor: 10000,
      variants: [{ sku: 'BAD', name: 'Bad', priceMinor: 1, stock: -1 }],
    }).success).toBe(false);
  });

  it('enforces tenant-safe variants and one primary image per target', () => {
    const database = fixture();
    database.exec(`
      INSERT INTO product_variants (
        id, merchant_id, product_id, sku, name, price_minor, stock, position
      ) VALUES (
        'variant-1', 'merchant-1', 'product-1', 'BLUE-L', 'Blue / Large', 11000, 2, 0
      );
      INSERT INTO media_assets (
        id, merchant_id, product_id, r2_key, content_type, byte_size, variant_id, role
      ) VALUES (
        'image-1', 'merchant-1', 'product-1', 'one.webp', 'image/webp', 10,
        'variant-1', 'primary'
      );
    `);
    expect(() => database.exec(`
      INSERT INTO product_variants (
        id, merchant_id, product_id, sku, name, price_minor, stock
      ) VALUES ('bad-tenant', 'merchant-2', 'product-1', 'BAD', 'Bad', 1, 1)
    `)).toThrow(/tenant mismatch/);
    expect(() => database.exec(`
      INSERT INTO media_assets (
        id, merchant_id, product_id, r2_key, content_type, byte_size, variant_id, role
      ) VALUES (
        'image-2', 'merchant-1', 'product-1', 'two.webp', 'image/webp', 10,
        'variant-1', 'primary'
      )
    `)).toThrow(/UNIQUE/);
  });

  it('cascades variant image records when a variant is removed', () => {
    const database = fixture();
    database.exec(`
      INSERT INTO product_variants (
        id, merchant_id, product_id, sku, name, price_minor, stock
      ) VALUES ('variant-1', 'merchant-1', 'product-1', 'SMALL', 'Small', 10000, 3);
      INSERT INTO media_assets (
        id, merchant_id, product_id, r2_key, content_type, byte_size, variant_id, role
      ) VALUES (
        'image-1', 'merchant-1', 'product-1', 'variant.webp', 'image/webp', 10,
        'variant-1', 'primary'
      );
      DELETE FROM product_variants WHERE id = 'variant-1';
    `);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM media_assets WHERE id = 'image-1'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
