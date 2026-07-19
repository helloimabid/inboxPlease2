CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatching', 'dispatched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dispatched_at INTEGER
);

CREATE INDEX idx_outbox_dispatchable
  ON outbox_events(status, available_at, lease_expires_at, created_at);

-- An idempotency key identifies both an order and the normalized request that
-- created it. This prevents a client bug from replaying a different cart under
-- a previously successful key.
ALTER TABLE orders ADD COLUMN request_fingerprint TEXT;

-- The provider attempt can only be created after the exact transaction has
-- been reserved on the same order. Because both statements run in one D1
-- batch, this trigger aborts and rolls back a partial checkout reservation.
CREATE TRIGGER payment_attempts_reservation_insert
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM orders
  WHERE id = NEW.order_id
    AND merchant_id = NEW.merchant_id
    AND payment_transaction_id = NEW.transaction_id
    AND payment_status = 'pending'
    AND total_minor = NEW.amount_minor
    AND currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'payment attempt reservation mismatch');
END;

-- The trigger runs under D1's serialized write transaction, closing the race
-- between the route's friendly quota precheck and concurrent product inserts.
CREATE TRIGGER products_plan_limit_insert
BEFORE INSERT ON products
WHEN NEW.status <> 'archived' AND ((
  (SELECT plan FROM merchants WHERE id = NEW.merchant_id) = 'free'
  AND (SELECT COUNT(*) FROM products
       WHERE merchant_id = NEW.merchant_id AND status <> 'archived') >= 10
) OR (
  (SELECT plan FROM merchants WHERE id = NEW.merchant_id) = 'pro'
  AND (SELECT COUNT(*) FROM products
       WHERE merchant_id = NEW.merchant_id AND status <> 'archived') >= 100
))
BEGIN
  SELECT RAISE(ABORT, 'product limit reached');
END;

CREATE TRIGGER products_plan_limit_reactivate
BEFORE UPDATE OF status, merchant_id ON products
WHEN NEW.status <> 'archived'
  AND (OLD.status = 'archived' OR OLD.merchant_id <> NEW.merchant_id)
  AND ((
    (SELECT plan FROM merchants WHERE id = NEW.merchant_id) = 'free'
    AND (SELECT COUNT(*) FROM products
         WHERE merchant_id = NEW.merchant_id AND status <> 'archived') >= 10
  ) OR (
    (SELECT plan FROM merchants WHERE id = NEW.merchant_id) = 'pro'
    AND (SELECT COUNT(*) FROM products
         WHERE merchant_id = NEW.merchant_id AND status <> 'archived') >= 100
  ))
BEGIN
  SELECT RAISE(ABORT, 'product limit reached');
END;

-- Recheck the validated catalog snapshot inside the order's write transaction.
-- The subsequent stock decrement remains protected by the products stock CHECK.
CREATE TRIGGER order_items_catalog_snapshot_insert
BEFORE INSERT ON order_items
WHEN NOT EXISTS (
  SELECT 1
  FROM products AS product
  JOIN orders AS customer_order ON customer_order.id = NEW.order_id
  WHERE product.id = NEW.product_id
    AND product.merchant_id = customer_order.merchant_id
    AND product.page_id = customer_order.page_id
    AND product.status = 'active'
    AND product.stock >= NEW.quantity
    AND product.price_minor = NEW.unit_price_minor
)
BEGIN
  SELECT RAISE(ABORT, 'order item changed');
END;

-- Cancellation is a one-way state transition. Restock every line in the same
-- transaction as the status mutation, guarded by OLD.status so it runs once.
CREATE TRIGGER orders_cancelled_restock
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
BEGIN
  UPDATE products
  SET stock = stock + (
        SELECT quantity FROM order_items
        WHERE order_id = NEW.id AND product_id = products.id
      ),
      updated_at = unixepoch()
  WHERE id IN (
    SELECT product_id FROM order_items WHERE order_id = NEW.id
  );
END;
