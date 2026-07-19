PRAGMA foreign_keys = ON;

CREATE TABLE product_variants (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (product_id, sku)
);

CREATE INDEX idx_product_variants_tenant_product
  ON product_variants(merchant_id, product_id, position, created_at);

CREATE TRIGGER product_variants_tenant_product_insert
BEFORE INSERT ON product_variants
WHEN NOT EXISTS (
  SELECT 1 FROM products
  WHERE id = NEW.product_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'variant product tenant mismatch');
END;

CREATE TRIGGER product_variants_tenant_product_update
BEFORE UPDATE OF merchant_id, product_id ON product_variants
WHEN NOT EXISTS (
  SELECT 1 FROM products
  WHERE id = NEW.product_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'variant product tenant mismatch');
END;

ALTER TABLE media_assets
  ADD COLUMN variant_id TEXT REFERENCES product_variants(id) ON DELETE CASCADE;

ALTER TABLE media_assets
  ADD COLUMN role TEXT NOT NULL DEFAULT 'gallery'
  CHECK (role IN ('primary', 'gallery'));

CREATE INDEX idx_media_tenant_variant
  ON media_assets(merchant_id, variant_id, created_at DESC);

CREATE UNIQUE INDEX idx_media_product_primary
  ON media_assets(product_id)
  WHERE variant_id IS NULL AND role = 'primary';

CREATE UNIQUE INDEX idx_media_variant_primary
  ON media_assets(variant_id)
  WHERE variant_id IS NOT NULL AND role = 'primary';

CREATE TRIGGER media_variant_consistency_insert
BEFORE INSERT ON media_assets
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM product_variants
  WHERE id = NEW.variant_id
    AND product_id = NEW.product_id
    AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'media variant tenant mismatch');
END;

CREATE TRIGGER media_variant_consistency_update
BEFORE UPDATE OF merchant_id, product_id, variant_id ON media_assets
WHEN NEW.variant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM product_variants
  WHERE id = NEW.variant_id
    AND product_id = NEW.product_id
    AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'media variant tenant mismatch');
END;
