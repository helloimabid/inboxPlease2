import { assertPageOwned, stableEventId, type OrderRow, type ProductRow } from './db';
import type { Bindings, CatalogQueueJob } from './env';
import { dispatchOutboxAfterCommit, prepareOutboxInsert } from './outbox';
import { sha256Name } from './security';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  merchantId: string;
  pageId: string;
  customerPsid: string;
  /** Defaults to 'BDT', matching createOrderSchema's default for the HTTP route. */
  currency?: string;
  items: OrderItemInput[];
  shippingAddress: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Thrown for any expected validation/business-rule failure. Distinct from a
 * plain Error so callers (the HTTP route, the chat tool handler) can each
 * decide how to surface it — as an ApiError with a status code, or as a
 * tool_result the model can react to conversationally.
 */
export class OrderCreationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrderCreationError';
    this.code = code;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

export async function orderRequestFingerprint(input: {
  pageId: string;
  customerPsid: string;
  currency: string;
  items: OrderItemInput[];
  shippingAddress: Record<string, unknown>;
}): Promise<string> {
  const quantities = new Map<string, number>();
  for (const item of input.items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  const normalized = {
    pageId: input.pageId,
    customerPsid: input.customerPsid,
    currency: input.currency,
    items: [...quantities.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([productId, quantity]) => ({ productId, quantity })),
    shippingAddress: input.shippingAddress,
  };
  return sha256Name(['order-request-v1', canonicalJson(normalized)]);
}

export function orderJson(row: OrderRow) {
  return {
    id: row.id,
    pageId: row.page_id,
    customerPsid: row.customer_psid,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentTransactionId: row.payment_transaction_id,
    totalMinor: row.total_minor,
    currency: row.currency,
    shippingAddress: JSON.parse(row.shipping_address_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Shared, allowlisted order-creation path. Both the authenticated dashboard/API
 * route and the chat tool-calling handler go through this function so an
 * AI-proposed order is validated by the exact same deterministic business
 * rules (stock, price, currency, idempotency) as a human-created one. Price,
 * stock, and product existence are always re-read from D1 here — nothing
 * about this function trusts a caller's (including the model's) description
 * of them. See docs/architecture-decisions.md: "AI output is advisory... Any
 * future tool calls must use allowlisted structured inputs and deterministic
 * business-rule validation."
 */
export async function createOrderCore(
  env: Bindings,
  input: CreateOrderInput,
): Promise<{ order: OrderRow; created: boolean }> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw new OrderCreationError(
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8-128 URL-safe characters',
    );
  }
  const currency = input.currency ?? 'BDT';
  const requestFingerprint = await orderRequestFingerprint({ ...input, currency });

  const existing = await env.DB.prepare(
    'SELECT * FROM orders WHERE merchant_id = ?1 AND idempotency_key = ?2',
  ).bind(input.merchantId, input.idempotencyKey)
    .first<OrderRow & { request_fingerprint: string | null }>();
  if (existing) {
    if (existing.request_fingerprint !== requestFingerprint) {
      throw new OrderCreationError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used for a different order request',
      );
    }
    return { order: existing, created: false };
  }

  await assertPageOwned(env.DB, input.merchantId, input.pageId);

  const quantities = new Map<string, number>();
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 100) {
      throw new OrderCreationError('INVALID_ORDER_ITEM', `Invalid quantity for ${item.productId}`);
    }
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  if (quantities.size === 0) {
    throw new OrderCreationError('EMPTY_ORDER', 'An order needs at least one item');
  }
  const productIds = [...quantities.keys()];
  const products = await Promise.all(productIds.map((id) => env.DB.prepare(
    `SELECT id, merchant_id, page_id, sku, name, description, price_minor,
            currency, stock, status, created_at, updated_at
     FROM products WHERE id = ?1 AND merchant_id = ?2`,
  ).bind(id, input.merchantId).first<ProductRow>()));
  if (products.some((product) => !product)) {
    throw new OrderCreationError('INVALID_ORDER_ITEM', 'One or more products do not exist');
  }
  const verified = products as ProductRow[];
  let totalMinor = 0;
  for (const product of verified) {
    const quantity = quantities.get(product.id) ?? 0;
    if (product.page_id !== input.pageId || product.status !== 'active') {
      throw new OrderCreationError('INVALID_ORDER_ITEM', `Product ${product.id} is unavailable`);
    }
    if (product.currency !== currency) {
      throw new OrderCreationError('CURRENCY_MISMATCH', 'All order items must use the order currency');
    }
    if (product.stock < quantity) {
      throw new OrderCreationError('INSUFFICIENT_STOCK', `Insufficient stock for ${product.name}`);
    }
    totalMinor += product.price_minor * quantity;
    if (!Number.isSafeInteger(totalMinor)) {
      throw new OrderCreationError('AMOUNT_TOO_LARGE', 'Order total exceeds the supported range');
    }
  }

  const orderId = crypto.randomUUID();
  const catalogJobs = await Promise.all(verified.map(async (product): Promise<CatalogQueueJob> => ({
    type: 'catalog.reindex',
    eventId: await stableEventId(['order-stock', input.merchantId, orderId, product.id]),
    merchantId: input.merchantId,
    pageId: input.pageId,
    productId: product.id,
    operation: 'upsert',
  })));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO orders
         (id, merchant_id, page_id, customer_psid, total_minor, currency,
          shipping_address_json, idempotency_key, request_fingerprint)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      orderId, input.merchantId, input.pageId, input.customerPsid,
      totalMinor, currency, JSON.stringify(input.shippingAddress), input.idempotencyKey,
      requestFingerprint,
    ),
  ];
  for (const [index, product] of verified.entries()) {
    const quantity = quantities.get(product.id) ?? 0;
    const catalogJob = catalogJobs[index];
    if (!catalogJob) throw new Error('Missing catalog stock job');
    statements.push(
      env.DB.prepare(
        `INSERT INTO order_items
           (order_id, product_id, name_snapshot, unit_price_minor, quantity)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(orderId, product.id, product.name, product.price_minor, quantity),
      // The stock CHECK constraint makes the entire D1 batch roll back if it would go negative.
      env.DB.prepare(
        'UPDATE products SET stock = stock - ?3, updated_at = unixepoch() WHERE id = ?1 AND merchant_id = ?2',
      ).bind(product.id, input.merchantId, quantity),
      prepareOutboxInsert(env.DB, catalogJob),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).toLowerCase().includes('order item changed')) {
      throw new OrderCreationError(
        'ORDER_ITEM_CHANGED',
        'A product changed while the order was created; review the cart and retry',
      );
    }
    if (String(error).includes('CHECK')) {
      throw new OrderCreationError('INSUFFICIENT_STOCK', 'Stock changed while the order was created');
    }
    // A concurrent retry can win the unique idempotency-key race. The losing
    // D1 batch is rolled back, including its stock updates, so return the winner.
    if (String(error).includes('UNIQUE')) {
      const winner = await env.DB.prepare(
        'SELECT * FROM orders WHERE merchant_id = ?1 AND idempotency_key = ?2',
      ).bind(input.merchantId, input.idempotencyKey)
        .first<OrderRow & { request_fingerprint: string | null }>();
      if (winner) {
        if (winner.request_fingerprint !== requestFingerprint) {
          throw new OrderCreationError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used for a different order request',
          );
        }
        return { order: winner, created: false };
      }
    }
    throw error;
  }
  await Promise.all(catalogJobs.map((job) => dispatchOutboxAfterCommit(env, job.eventId)));
  const order = await env.DB.prepare(
    'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
  ).bind(orderId, input.merchantId).first<OrderRow>();
  if (!order) throw new Error('Order vanished immediately after creation');
  return { order, created: true };
}

/**
 * Order-status lookup scoped to the requesting customer. The customerPsid
 * check is deliberate: it stops one Messenger user from fishing for another
 * customer's order by guessing or being told an order ID.
 */
export async function getOrderStatusForCustomer(
  env: Bindings,
  merchantId: string,
  customerPsid: string,
  orderId: string,
): Promise<OrderRow | null> {
  return env.DB.prepare(
    'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2 AND customer_psid = ?3',
  ).bind(orderId, merchantId, customerPsid).first<OrderRow>();
}