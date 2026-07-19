import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { flag } from '../config';
import { assertPageOwned, stableEventId, type OrderRow, type ProductRow } from '../db';
import type { AppEnv, CatalogQueueJob, OrderStatusQueueJob } from '../env';
import { ApiError, jsonOk } from '../errors';
import { dispatchOutboxAfterCommit, prepareOutboxInsert } from '../outbox';
import {
  checkoutCustomerSchema,
  createOrderSchema,
  orderQuerySchema,
  updateOrderStatusSchema,
} from '../schemas';
import { createSslCommerzCheckout } from '../integrations/sslcommerz';
import { sha256Name } from '../security';
import { validationHook } from '../validation';
import { ORDER_MUTATION_ROLES, requireRole } from '../auth';

const transitions: Record<string, readonly string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled', 'refunded'],
  processing: ['shipped', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function isValidOrderTransition(current: string, next: string): boolean {
  return transitions[current]?.includes(next) ?? false;
}

export function didOrderTransitionCommit(
  reportedChanges: number | undefined,
  observedStatus: string | undefined,
  expectedStatus: string,
): boolean {
  return reportedChanges === 1 || observedStatus === expectedStatus;
}

interface OrderRequestInput {
  pageId: string;
  customerPsid: string;
  currency: string;
  items: Array<{ productId: string; quantity: number }>;
  shippingAddress: Record<string, unknown>;
}

type OrderWithFingerprint = OrderRow & { request_fingerprint: string | null };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

export async function orderRequestFingerprint(input: OrderRequestInput): Promise<string> {
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

function orderJson(row: OrderRow) {
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

export const ordersRoutes = new Hono<AppEnv>()
  .get('/', zValidator('query', orderQuerySchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const query = c.req.valid('query');
    const result = query.status
      ? await c.env.DB.prepare(
          `SELECT * FROM orders WHERE merchant_id = ?1 AND status = ?2
           ORDER BY created_at DESC LIMIT ?3 OFFSET ?4`,
        ).bind(merchantId, query.status, query.limit, query.offset).all<OrderRow>()
      : await c.env.DB.prepare(
          `SELECT * FROM orders WHERE merchant_id = ?1
           ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
        ).bind(merchantId, query.limit, query.offset).all<OrderRow>();
    return jsonOk(c, {
      items: result.results.map(orderJson),
      pagination: { limit: query.limit, offset: query.offset },
    });
  })
  .get('/:orderId', async (c) => {
    const { merchantId } = c.get('auth');
    const orderId = c.req.param('orderId');
    const order = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
    ).bind(orderId, merchantId).first<OrderRow>();
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    const items = await c.env.DB.prepare(
      `SELECT product_id, name_snapshot, unit_price_minor, quantity
       FROM order_items WHERE order_id = ?1`,
    ).bind(orderId).all<{
      product_id: string; name_snapshot: string; unit_price_minor: number; quantity: number;
    }>();
    return jsonOk(c, {
      ...orderJson(order),
      items: items.results.map((item) => ({
        productId: item.product_id,
        name: item.name_snapshot,
        unitPriceMinor: item.unit_price_minor,
        quantity: item.quantity,
      })),
    });
  })
  .post('/', requireRole(...ORDER_MUTATION_ROLES), zValidator('json', createOrderSchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const input = c.req.valid('json');
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ApiError(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8-128 URL-safe characters',
      );
    }
    const requestFingerprint = await orderRequestFingerprint(input);

    const existing = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE merchant_id = ?1 AND idempotency_key = ?2',
    ).bind(merchantId, idempotencyKey).first<OrderWithFingerprint>();
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new ApiError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used for a different order request',
        );
      }
      return jsonOk(c, orderJson(existing));
    }

    await assertPageOwned(c.env.DB, merchantId, input.pageId);

    const quantities = new Map<string, number>();
    for (const item of input.items) {
      quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
    }
    const productIds = [...quantities.keys()];
    const products = await Promise.all(productIds.map((id) => c.env.DB.prepare(
      `SELECT id, merchant_id, page_id, sku, name, description, price_minor,
              currency, stock, status, created_at, updated_at
       FROM products WHERE id = ?1 AND merchant_id = ?2`,
    ).bind(id, merchantId).first<ProductRow>()));
    if (products.some((product) => !product)) {
      throw new ApiError(422, 'INVALID_ORDER_ITEM', 'One or more products do not exist');
    }
    const verified = products as ProductRow[];
    let totalMinor = 0;
    for (const product of verified) {
      const quantity = quantities.get(product.id) ?? 0;
      if (product.page_id !== input.pageId || product.status !== 'active') {
        throw new ApiError(422, 'INVALID_ORDER_ITEM', `Product ${product.id} is unavailable`);
      }
      if (product.currency !== input.currency) {
        throw new ApiError(422, 'CURRENCY_MISMATCH', 'All order items must use the order currency');
      }
      if (product.stock < quantity) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient stock for ${product.name}`);
      }
      totalMinor += product.price_minor * quantity;
      if (!Number.isSafeInteger(totalMinor)) {
        throw new ApiError(422, 'AMOUNT_TOO_LARGE', 'Order total exceeds the supported range');
      }
    }

    const orderId = crypto.randomUUID();
    const catalogJobs = await Promise.all(verified.map(async (product): Promise<CatalogQueueJob> => ({
      type: 'catalog.reindex',
      eventId: await stableEventId(['order-stock', merchantId, orderId, product.id]),
      merchantId,
      pageId: input.pageId,
      productId: product.id,
      operation: 'upsert',
    })));
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO orders
           (id, merchant_id, page_id, customer_psid, total_minor, currency,
            shipping_address_json, idempotency_key, request_fingerprint)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        orderId, merchantId, input.pageId, input.customerPsid,
        totalMinor, input.currency, JSON.stringify(input.shippingAddress), idempotencyKey,
        requestFingerprint,
      ),
    ];
    for (const [index, product] of verified.entries()) {
      const quantity = quantities.get(product.id) ?? 0;
      const catalogJob = catalogJobs[index];
      if (!catalogJob) throw new Error('Missing catalog stock job');
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO order_items
             (order_id, product_id, name_snapshot, unit_price_minor, quantity)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(orderId, product.id, product.name, product.price_minor, quantity),
        // The stock CHECK constraint makes the entire D1 batch roll back if it would go negative.
        c.env.DB.prepare(
          'UPDATE products SET stock = stock - ?3, updated_at = unixepoch() WHERE id = ?1 AND merchant_id = ?2',
        ).bind(product.id, merchantId, quantity),
        prepareOutboxInsert(c.env.DB, catalogJob),
      );
    }
    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      if (String(error).toLowerCase().includes('order item changed')) {
        throw new ApiError(
          409,
          'ORDER_ITEM_CHANGED',
          'A product changed while the order was created; review the cart and retry',
        );
      }
      if (String(error).includes('CHECK')) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Stock changed while the order was created');
      }
      // A concurrent retry can win the unique idempotency-key race. The losing
      // D1 batch is rolled back, including its stock updates, so return the winner.
      if (String(error).includes('UNIQUE')) {
        const winner = await c.env.DB.prepare(
          'SELECT * FROM orders WHERE merchant_id = ?1 AND idempotency_key = ?2',
        ).bind(merchantId, idempotencyKey).first<OrderWithFingerprint>();
        if (winner) {
          if (winner.request_fingerprint !== requestFingerprint) {
            throw new ApiError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key was already used for a different order request',
            );
          }
          return jsonOk(c, orderJson(winner));
        }
      }
      throw error;
    }
    c.executionCtx.waitUntil(Promise.all(
      catalogJobs.map((job) => dispatchOutboxAfterCommit(c.env, job.eventId)),
    ).then(() => undefined));
    const order = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
    ).bind(orderId, merchantId).first<OrderRow>();
    if (!order) throw new Error('Created order could not be read');
    return jsonOk(c, orderJson(order), 201);
  })
  .post('/:orderId/checkout', requireRole(...ORDER_MUTATION_ROLES), zValidator('json', checkoutCustomerSchema, validationHook), async (c) => {
    if (!flag(c.env.PAYMENTS_ENABLED)) {
      throw new ApiError(503, 'PAYMENTS_DISABLED', 'Payments are disabled in this environment');
    }
    const { merchantId } = c.get('auth');
    const orderId = c.req.param('orderId');
    const customer = c.req.valid('json');
    const order = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
    ).bind(orderId, merchantId).first<OrderRow>();
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    if (order.payment_status === 'paid') {
      throw new ApiError(409, 'ORDER_ALREADY_PAID', 'Order has already been paid');
    }
    if (!['pending', 'confirmed', 'processing'].includes(order.status)) {
      throw new ApiError(409, 'ORDER_NOT_PAYABLE', `A ${order.status} order cannot enter checkout`);
    }
    if (order.currency !== 'BDT' || order.total_minor <= 0) {
      throw new ApiError(422, 'UNSUPPORTED_PAYMENT_AMOUNT', 'SSLCommerz checkout requires a positive BDT amount');
    }
    if (order.payment_transaction_id || order.payment_status === 'pending') {
      throw new ApiError(409, 'PAYMENT_ALREADY_PENDING', 'A payment is already pending for this order');
    }
    if (
      !c.env.SSLCOMMERZ_STORE_ID || !c.env.SSLCOMMERZ_STORE_PASSWORD ||
      !c.env.PUBLIC_API_BASE_URL
    ) {
      throw new ApiError(503, 'PAYMENT_NOT_CONFIGURED', 'Payment credentials or callback URL are missing');
    }
    // SSLCommerz limits tran_id to 30 characters.
    const transactionId = `ip-${crypto.randomUUID().replace(/-/g, '').slice(0, 27)}`;
    try {
      const [reserved] = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE orders SET payment_transaction_id = ?3, payment_status = 'pending',
             updated_at = unixepoch()
           WHERE id = ?1 AND merchant_id = ?2
             AND status IN ('pending', 'confirmed', 'processing')
             AND payment_status IN ('unpaid', 'failed') AND payment_transaction_id IS NULL`,
        ).bind(orderId, merchantId, transactionId),
        c.env.DB.prepare(
          `INSERT INTO payment_attempts
             (transaction_id, order_id, merchant_id, amount_minor, currency, status)
           VALUES (?1, ?2, ?3, ?4, ?5, 'initializing')`,
        ).bind(transactionId, orderId, merchantId, order.total_minor, order.currency),
      ]);
      if ((reserved?.meta.changes ?? 0) !== 1) {
        throw new ApiError(409, 'PAYMENT_INTENT_CONFLICT', 'Payment intent could not be reserved');
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const detail = String(error);
      if (detail.includes('payment attempt reservation mismatch') || detail.includes('UNIQUE')) {
        throw new ApiError(409, 'PAYMENT_INTENT_CONFLICT', 'Payment intent could not be reserved');
      }
      throw error;
    }
    try {
      const session = await createSslCommerzCheckout(c.env, {
        orderId,
        transactionId,
        amountMinor: order.total_minor,
        currency: order.currency,
      }, customer);
      await c.env.DB.prepare(
        `UPDATE payment_attempts SET status = 'pending', gateway_session_key = ?2,
           gateway_page_url = ?3, updated_at = unixepoch()
         WHERE transaction_id = ?1`,
      ).bind(transactionId, session.sessionKey, session.gatewayPageUrl).run();
      return jsonOk(c, {
        orderId,
        transactionId,
        amountMinor: order.total_minor,
        currency: order.currency,
        gatewayPageUrl: session.gatewayPageUrl,
        sessionKey: session.sessionKey,
      }, 201);
    } catch (error) {
      await c.env.DB.prepare(
        `UPDATE payment_attempts SET status = 'unknown', last_error = ?2,
           updated_at = unixepoch() WHERE transaction_id = ?1`,
      ).bind(transactionId, String(error).slice(0, 500)).run();
      // Keep the exact transaction reservation: an ambiguous timeout can still
      // have created a live provider session whose eventual IPN must reconcile.
      throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'SSLCommerz checkout could not be created');
    }
  })
  .patch('/:orderId/status', requireRole(...ORDER_MUTATION_ROLES), zValidator('json', updateOrderStatusSchema, validationHook), async (c) => {
    const { merchantId } = c.get('auth');
    const orderId = c.req.param('orderId');
    const { status } = c.req.valid('json');
    const current = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
    ).bind(orderId, merchantId).first<OrderRow>();
    if (!current) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    if (status === 'refunded') {
      throw new ApiError(
        409,
        'REFUND_WORKFLOW_REQUIRED',
        'Refunds require a verified payment-provider refund workflow',
      );
    }
    if (status === 'cancelled' && current.payment_status === 'paid') {
      throw new ApiError(
        409,
        'PAID_ORDER_CANNOT_CANCEL',
        'Refund the payment through the provider before cancelling this order',
      );
    }
    if (!isValidOrderTransition(current.status, status)) {
      throw new ApiError(409, 'INVALID_ORDER_TRANSITION', `Cannot move ${current.status} order to ${status}`);
    }
    const job: OrderStatusQueueJob = {
      type: 'order.status.dispatch',
      eventId: await stableEventId([
        'order-status', merchantId, orderId, current.status, status,
      ]),
      merchantId,
      orderId,
      status,
    };
    const [changed] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE orders SET status = ?3, updated_at = unixepoch()
         WHERE id = ?1 AND merchant_id = ?2 AND status = ?4`,
      ).bind(orderId, merchantId, status, current.status),
      prepareOutboxInsert(c.env.DB, job, {
        sql: `EXISTS (
          SELECT 1 FROM orders
          WHERE id = ? AND merchant_id = ? AND status = ?
        )`,
        values: [orderId, merchantId, status],
      }),
    ]);
    // SQLite trigger side effects can make local D1 report ambiguous `changes`
    // metadata for this batch even when the guarded order update committed.
    // Resolve that ambiguity from persisted state; a different final status is
    // still a real CAS conflict.
    if ((changed?.meta.changes ?? 0) !== 1) {
      const observed = await c.env.DB.prepare(
        'SELECT status FROM orders WHERE id = ?1 AND merchant_id = ?2',
      ).bind(orderId, merchantId).first<{ status: string }>();
      if (!didOrderTransitionCommit(changed?.meta.changes, observed?.status, status)) {
        throw new ApiError(409, 'ORDER_STATE_CHANGED', 'Order status changed; reload and try again');
      }
    }
    c.executionCtx.waitUntil(dispatchOutboxAfterCommit(c.env, job.eventId));
    const updated = await c.env.DB.prepare(
      'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
    ).bind(orderId, merchantId).first<OrderRow>();
    if (!updated) throw new Error('Updated order could not be read');
    return jsonOk(c, orderJson(updated));
  });
