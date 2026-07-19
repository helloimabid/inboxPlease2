CREATE TABLE payment_attempts (
  transaction_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing', 'pending', 'paid', 'review', 'unknown', 'cancelled')),
  gateway_session_key TEXT,
  gateway_page_url TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_payment_attempts_order ON payment_attempts(merchant_id, order_id, created_at DESC);
