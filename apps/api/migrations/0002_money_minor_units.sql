-- Make the unit explicit: BDT values are integer minor units (paisa), never floats.
ALTER TABLE merchant_settings RENAME COLUMN escalation_cart_threshold_cents TO escalation_cart_threshold_minor;
ALTER TABLE products RENAME COLUMN price_cents TO price_minor;
ALTER TABLE orders RENAME COLUMN total_cents TO total_minor;
ALTER TABLE order_items RENAME COLUMN unit_price_cents TO unit_price_minor;
