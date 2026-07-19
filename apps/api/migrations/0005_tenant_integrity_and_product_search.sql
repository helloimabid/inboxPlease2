-- Enforce tenant relationships even though the original MVP tables used
-- independent single-column foreign keys. These triggers are append-only and
-- protect queue/future-code paths as well as today's HTTP routes.
CREATE TRIGGER products_tenant_page_insert
BEFORE INSERT ON products
WHEN NOT EXISTS (
  SELECT 1 FROM store_pages
  WHERE id = NEW.page_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'product page tenant mismatch');
END;

CREATE TRIGGER products_tenant_page_update
BEFORE UPDATE OF merchant_id, page_id ON products
WHEN NOT EXISTS (
  SELECT 1 FROM store_pages
  WHERE id = NEW.page_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'product page tenant mismatch');
END;

CREATE TRIGGER orders_tenant_page_insert
BEFORE INSERT ON orders
WHEN NOT EXISTS (
  SELECT 1 FROM store_pages
  WHERE id = NEW.page_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'order page tenant mismatch');
END;

CREATE TRIGGER orders_tenant_page_update
BEFORE UPDATE OF merchant_id, page_id ON orders
WHEN NOT EXISTS (
  SELECT 1 FROM store_pages
  WHERE id = NEW.page_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'order page tenant mismatch');
END;

CREATE TRIGGER media_tenant_product_insert
BEFORE INSERT ON media_assets
WHEN NEW.product_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM products
  WHERE id = NEW.product_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'media product tenant mismatch');
END;

CREATE TRIGGER media_tenant_product_update
BEFORE UPDATE OF merchant_id, product_id ON media_assets
WHEN NEW.product_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM products
  WHERE id = NEW.product_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'media product tenant mismatch');
END;

CREATE TRIGGER order_items_tenant_insert
BEFORE INSERT ON order_items
WHEN NOT EXISTS (
  SELECT 1
  FROM orders AS o
  JOIN products AS p ON p.id = NEW.product_id
  WHERE o.id = NEW.order_id AND o.merchant_id = p.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item tenant mismatch');
END;

CREATE TRIGGER payment_attempts_tenant_insert
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE id = NEW.order_id AND merchant_id = NEW.merchant_id
)
BEGIN
  SELECT RAISE(ABORT, 'payment attempt tenant mismatch');
END;

-- D1 FTS5 search for the MVP. Product identity and tenant columns are carried
-- as unindexed metadata; tenant ownership is still enforced by the outer query.
CREATE VIRTUAL TABLE products_fts USING fts5(
  product_id UNINDEXED,
  merchant_id UNINDEXED,
  page_id UNINDEXED,
  name,
  sku,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO products_fts (product_id, merchant_id, page_id, name, sku, description)
SELECT id, merchant_id, page_id, name, sku, description FROM products;

CREATE TRIGGER products_fts_insert AFTER INSERT ON products BEGIN
  INSERT INTO products_fts (product_id, merchant_id, page_id, name, sku, description)
  VALUES (NEW.id, NEW.merchant_id, NEW.page_id, NEW.name, NEW.sku, NEW.description);
END;

CREATE TRIGGER products_fts_update
AFTER UPDATE OF merchant_id, page_id, name, sku, description ON products BEGIN
  DELETE FROM products_fts WHERE product_id = OLD.id;
  INSERT INTO products_fts (product_id, merchant_id, page_id, name, sku, description)
  VALUES (NEW.id, NEW.merchant_id, NEW.page_id, NEW.name, NEW.sku, NEW.description);
END;

CREATE TRIGGER products_fts_delete AFTER DELETE ON products BEGIN
  DELETE FROM products_fts WHERE product_id = OLD.id;
END;
