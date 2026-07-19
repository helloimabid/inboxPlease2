PRAGMA foreign_keys = ON;

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE store_pages (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  meta_page_access_token TEXT,
  connected_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_store_pages_merchant ON store_pages(merchant_id, id);

CREATE TABLE merchant_settings (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  assistant_name TEXT NOT NULL DEFAULT 'InboxPlease',
  store_description TEXT NOT NULL DEFAULT '',
  default_language TEXT NOT NULL DEFAULT 'auto' CHECK (default_language IN ('auto', 'bn', 'en', 'banglish')),
  tone TEXT NOT NULL DEFAULT 'friendly' CHECK (tone IN ('friendly', 'professional', 'concise')),
  currency TEXT NOT NULL DEFAULT 'BDT',
  business_hours_json TEXT NOT NULL DEFAULT '{}',
  escalation_cart_threshold_cents INTEGER NOT NULL DEFAULT 500000 CHECK (escalation_cart_threshold_cents >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES store_pages(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BDT',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (merchant_id, sku)
);
CREATE INDEX idx_products_tenant_page ON products(merchant_id, page_id, status, updated_at DESC);
CREATE INDEX idx_products_tenant_name ON products(merchant_id, name);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_media_tenant_product ON media_assets(merchant_id, product_id, created_at DESC);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES store_pages(id) ON DELETE RESTRICT,
  customer_psid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  payment_transaction_id TEXT UNIQUE,
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BDT',
  shipping_address_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_orders_tenant_status ON orders(merchant_id, status, created_at DESC);
CREATE INDEX idx_orders_tenant_customer ON orders(merchant_id, page_id, customer_psid, created_at DESC);

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE monthly_usage (
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  ai_messages INTEGER NOT NULL DEFAULT 0 CHECK (ai_messages >= 0),
  vision_messages INTEGER NOT NULL DEFAULT 0 CHECK (vision_messages >= 0),
  PRIMARY KEY (merchant_id, month)
);
