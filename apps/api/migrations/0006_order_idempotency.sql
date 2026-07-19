ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_orders_tenant_idempotency
  ON orders(merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
