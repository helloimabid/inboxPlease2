import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { flag } from '../config';
import { stableEventId, type OrderRow } from '../db';
import type { AppEnv, OrderStatusQueueJob } from '../env';
import { ApiError, jsonOk } from '../errors';
import { dispatchOutboxAfterCommit, prepareOutboxInsert } from '../outbox';
import {
  checkoutCustomerSchema,
  createOrderSchema,
  orderQuerySchema,
  updateOrderStatusSchema,
} from '../schemas';
import { createSslCommerzCheckout } from '../integrations/sslcommerz';
import { validationHook } from '../validation';
import { ORDER_MUTATION_ROLES, requireRole } from '../auth';
import { createOrderCore, OrderCreationError, orderJson } from '../orders-core';

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

// Re-exported so existing callers/tests that import the fingerprint helper
// from this route module keep working; the implementation now lives in
// orders-core.ts alongside createOrderCore so both this route and the chat
// tool-calling path hash requests identically.
export { orderRequestFingerprint } from '../orders-core';

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
    let created: boolean;
    let order: OrderRow;
    try {
      const result = await createOrderCore(c.env, {
        merchantId,
        pageId: input.pageId,
        customerPsid: input.customerPsid,
        currency: input.currency,
        items: input.items,
        shippingAddress: input.shippingAddress,
        idempotencyKey,
      });
      created = result.created;
      order = result.order;
    } catch (error) {
      if (error instanceof OrderCreationError) {
        const status = error.code === 'INSUFFICIENT_STOCK' || error.code === 'ORDER_ITEM_CHANGED'
          || error.code === 'IDEMPOTENCY_KEY_REUSED'
          ? 409
          : error.code === 'INVALID_IDEMPOTENCY_KEY'
            ? 400
            : 422;
        throw new ApiError(status, error.code, error.message);
      }
      throw error;
    }
    return jsonOk(c, orderJson(order), created ? 201 : 200);
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