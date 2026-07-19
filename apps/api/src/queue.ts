import { embedText } from './ai';
import { flag } from './config';
import { markWebhook, stableEventId, type OrderRow, type ProductRow } from './db';
import { customerThreadObjectName, storePageObjectName } from './durable/tenant-names';
import type {
  Bindings,
  CatalogQueueJob,
  MetaQueueJob,
  OrderStatusQueueJob,
  PaymentQueueJob,
  QueueJob,
  SettingsCacheQueueJob,
} from './env';
import {
  isActionableMetaEvent,
  isMetaHandoverEvent,
  isReadyPageCredential,
  sendProactiveOrderUpdate,
} from './integrations/meta';
import { validateSslCommerzPayment } from './integrations/sslcommerz';

type QueueClaim = 'owned' | 'processed' | 'busy';

async function claimQueueJob(env: Bindings, job: QueueJob): Promise<QueueClaim> {
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO queue_jobs (event_id, job_type, status)
     VALUES (?1, ?2, 'processing')`,
  ).bind(job.eventId, job.type).run();
  if ((inserted.meta.changes ?? 0) > 0) return 'owned';
  const takeover = await env.DB.prepare(
    `UPDATE queue_jobs SET status = 'processing', attempts = attempts + 1,
       last_error = NULL, updated_at = unixepoch()
     WHERE event_id = ?1
       AND (status = 'failed' OR (status = 'processing' AND updated_at < unixepoch() - 90))`,
  ).bind(job.eventId).run();
  if ((takeover.meta.changes ?? 0) > 0) return 'owned';
  const current = await env.DB.prepare(
    'SELECT status FROM queue_jobs WHERE event_id = ?1',
  ).bind(job.eventId).first<{ status: string }>();
  return current?.status === 'processed' ? 'processed' : 'busy';
}

async function finishQueueJob(
  env: Bindings,
  eventId: string,
  status: 'processed' | 'failed',
  error?: string,
) {
  await env.DB.prepare(
    `UPDATE queue_jobs SET status = ?2, last_error = ?3, updated_at = unixepoch()
     WHERE event_id = ?1`,
  ).bind(eventId, status, error ?? null).run();
}

async function processMetaJob(env: Bindings, job: MetaQueueJob) {
  await markWebhook(env.DB, 'meta', job.eventId, 'processing');
  for (const entry of job.payload.entry ?? []) {
    const pageId = entry.id;
    if (!pageId) continue;
    const page = await env.DB.prepare(
      `SELECT pages.merchant_id, pages.meta_page_access_token,
              pages.meta_subscription_status, pages.meta_permissions_json,
              pages.meta_tasks_json, pages.messaging_ready_at,
              pages.ai_messaging_enabled
       FROM store_pages AS pages
       JOIN merchants ON merchants.id = pages.merchant_id
       WHERE pages.id = ?1 AND merchants.status = 'active'`,
    ).bind(pageId).first<{
      merchant_id: string;
      meta_page_access_token: string | null;
      meta_subscription_status: string;
      meta_permissions_json: string;
      meta_tasks_json: string;
      messaging_ready_at: number | null;
      ai_messaging_enabled: number;
    }>();
    if (!page) {
      console.warn('Ignoring webhook for unknown page', pageId);
      continue;
    }
    for (const event of entry.messaging ?? []) {
      if (!isActionableMetaEvent(event)) continue;
      const handoverEvent = isMetaHandoverEvent(event);
      // Handover state must still converge while automation is paused. All
      // ordinary events stop before AI generation and usage counting unless
      // both platform kill switches and the seller's Page approval are active.
      if (!handoverEvent && (
        !flag(env.AI_ENABLED) || !flag(env.MESSAGING_ENABLED) ||
        !isReadyPageCredential(page)
      )) continue;
      const customerPsid = event.sender?.id;
      if (!customerPsid) continue;
      const eventId = await stableEventId([
        'meta-message', pageId, customerPsid,
        event.message?.mid ?? event.postback?.mid ?? String(event.timestamp ?? ''),
      ]);
      const name = await customerThreadObjectName(page.merchant_id, pageId, customerPsid);
      const stub = env.CUSTOMER_THREADS.get(env.CUSTOMER_THREADS.idFromName(name));
      const response = await stub.fetch(
        handoverEvent
          ? 'https://do.internal/events/handover'
          : 'https://do.internal/events/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          merchantId: page.merchant_id,
          pageId,
          customerPsid,
          event,
        }),
        },
      );
      if (!response.ok) throw new Error(`CustomerThreadDO failed: ${response.status}`);
    }
  }
  await markWebhook(env.DB, 'meta', job.eventId, 'processed');
}

async function processPaymentJob(env: Bindings, job: PaymentQueueJob) {
  await markWebhook(env.DB, 'sslcommerz', job.eventId, 'processing');
  const orderId = job.payload.value_a;
  const transactionId = job.payload.tran_id;
  const validationId = job.payload.val_id;
  if (!orderId || !transactionId || !validationId) throw new Error('Incomplete SSLCommerz callback');
  const order = await env.DB.prepare(
    `SELECT * FROM orders
     WHERE id = ?1 AND payment_transaction_id = ?2 AND payment_status = 'pending'`,
  ).bind(orderId, transactionId).first<OrderRow>();
  if (!order) {
    await markWebhook(env.DB, 'sslcommerz', job.eventId, 'ignored', 'Unknown order or transaction');
    return;
  }
  const validation = await validateSslCommerzPayment(env, validationId, {
    orderId: order.id,
    transactionId,
    amountMinor: order.total_minor,
    currency: order.currency,
  });
  if (!validation.valid) {
    await env.DB.prepare(
      `UPDATE payment_attempts SET status = 'review', last_error = ?2,
         updated_at = unixepoch() WHERE transaction_id = ?1`,
    ).bind(transactionId, `Validation rejected: ${validation.reason ?? 'unknown'}`).run();
    await markWebhook(
      env.DB,
      'sslcommerz',
      job.eventId,
      'ignored',
      `Validation rejected: ${validation.reason ?? 'unknown'}`,
    );
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET payment_status = 'paid', payment_transaction_id = ?3,
         updated_at = unixepoch()
       WHERE id = ?1 AND merchant_id = ?2 AND payment_status = 'pending'
         AND payment_transaction_id = ?3`,
    ).bind(order.id, order.merchant_id, transactionId),
    env.DB.prepare(
      `UPDATE payment_attempts SET status = 'paid', last_error = NULL,
         updated_at = unixepoch() WHERE transaction_id = ?1 AND order_id = ?2`,
    ).bind(transactionId, order.id),
  ]);
  await markWebhook(env.DB, 'sslcommerz', job.eventId, 'processed');
}

interface FlexibleVectorIndex {
  upsert(vectors: Array<Record<string, unknown>>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

async function syncStorePage(env: Bindings, job: CatalogQueueJob, product?: ProductRow) {
  const name = await storePageObjectName(job.merchantId, job.pageId);
  const stub = env.STORE_PAGES.get(env.STORE_PAGES.idFromName(name));
  const bootstrap = await stub.fetch('https://do.internal/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId: job.merchantId, pageId: job.pageId }),
  });
  if (!bootstrap.ok) throw new Error(`StorePageDO bootstrap failed: ${bootstrap.status}`);
  const response = product
    ? await stub.fetch('https://do.internal/catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantId: job.merchantId,
          pageId: job.pageId,
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            description: product.description,
            priceMinor: product.price_minor,
            currency: product.currency,
            stock: product.stock,
            status: product.status,
            updatedAt: product.updated_at,
          },
        }),
      })
    : await stub.fetch(`https://do.internal/catalog/${encodeURIComponent(job.productId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantId: job.merchantId, pageId: job.pageId }),
      });
  if (!response.ok) throw new Error(`StorePageDO catalog sync failed: ${response.status}`);
}

async function processCatalogJob(env: Bindings, job: CatalogQueueJob) {
  const vectorIndex = env.VECTORIZE_CATALOG as unknown as FlexibleVectorIndex;
  const product = await env.DB.prepare(
    `SELECT id, merchant_id, page_id, sku, name, description, price_minor,
            currency, stock, status, created_at, updated_at
     FROM products WHERE id = ?1 AND merchant_id = ?2 AND page_id = ?3`,
  ).bind(job.productId, job.merchantId, job.pageId).first<ProductRow>();
  // Resolve the current D1 state instead of trusting an older queued operation.
  // This makes delayed/reordered catalog events converge on the latest state.
  if (!product || product.status === 'archived') {
    if (flag(env.VECTOR_SEARCH_ENABLED)) await vectorIndex.deleteByIds([job.productId]);
    await syncStorePage(env, job);
    return;
  }
  const variants = await env.DB.prepare(
    `SELECT sku, name, price_minor, stock FROM product_variants
     WHERE merchant_id = ?1 AND product_id = ?2
     ORDER BY position, created_at`,
  ).bind(job.merchantId, job.productId).all<{
    sku: string;
    name: string;
    price_minor: number;
    stock: number;
  }>();
  const variantContext = variants.results.length
    ? `\nVariants:\n${variants.results.map((variant) =>
        `${variant.name} (SKU ${variant.sku}): ${variant.price_minor} ${product.currency} minor units, ${variant.stock} in stock`
      ).join('\n')}`
    : '';
  const contextualProduct = {
    ...product,
    description: `${product.description}${variantContext}`,
  };
  await syncStorePage(env, job, contextualProduct);
  if (product.status !== 'active') {
    if (flag(env.VECTOR_SEARCH_ENABLED)) await vectorIndex.deleteByIds([job.productId]);
    return;
  }
  if (flag(env.VECTOR_SEARCH_ENABLED) && flag(env.AI_ENABLED)) {
    const values = await embedText(
      env,
      `${product.name}\nSKU: ${product.sku}\n${contextualProduct.description}`,
    );
    if (values.length !== 1024) throw new Error(`Unexpected embedding size ${values.length}`);
    await vectorIndex.upsert([{
      id: product.id,
      values,
      namespace: product.page_id,
      metadata: {
        merchant_id: product.merchant_id,
        page_id: product.page_id,
        sku: product.sku,
        name: product.name,
      },
    }]);
  }
}

async function processOrderStatusJob(env: Bindings, job: OrderStatusQueueJob) {
  const order = await env.DB.prepare(
    'SELECT * FROM orders WHERE id = ?1 AND merchant_id = ?2',
  ).bind(job.orderId, job.merchantId).first<OrderRow>();
  if (!order) return;
  if (job.status === 'cancelled') {
    const items = await env.DB.prepare(
      'SELECT product_id FROM order_items WHERE order_id = ?1',
    ).bind(job.orderId).all<{ product_id: string }>();
    await Promise.all(items.results.map(({ product_id: productId }) => processCatalogJob(env, {
      type: 'catalog.reindex',
      eventId: `${job.eventId}:restock:${productId}`,
      merchantId: job.merchantId,
      pageId: order.page_id,
      productId,
      operation: 'upsert',
    })));
  }
  await sendProactiveOrderUpdate(
    env,
    job.merchantId,
    order.page_id,
    order.customer_psid,
    orderStatusMessage(job),
  );
}

export function orderStatusMessage(job: OrderStatusQueueJob): string {
  return `Order ${job.orderId} is now ${job.status}.`;
}

interface SettingsCacheRow {
  assistant_name: string;
  store_description: string;
  default_language: string;
  tone: string;
  currency: string;
  business_hours_json: string;
  escalation_cart_threshold_minor: number;
  updated_at: number;
}

async function processSettingsCacheJob(env: Bindings, job: SettingsCacheQueueJob) {
  const row = await env.DB.prepare(
    `SELECT assistant_name, store_description, default_language, tone, currency,
            business_hours_json, escalation_cart_threshold_minor, updated_at
     FROM merchant_settings WHERE merchant_id = ?1`,
  ).bind(job.merchantId).first<SettingsCacheRow>();
  if (!row) return;

  // Read at processing time so reordered refresh events always converge on the
  // newest committed settings instead of replaying an obsolete snapshot.
  const settings = {
    assistantName: row.assistant_name,
    storeDescription: row.store_description,
    defaultLanguage: row.default_language,
    tone: row.tone,
    currency: row.currency,
    businessHours: JSON.parse(row.business_hours_json) as unknown,
    escalationCartThresholdMinor: row.escalation_cart_threshold_minor,
    updatedAt: row.updated_at,
  };
  const pages = await env.DB.prepare(
    'SELECT id FROM store_pages WHERE merchant_id = ?1',
  ).bind(job.merchantId).all<{ id: string }>();
  await Promise.all(pages.results.map(async ({ id: pageId }) => {
    const name = await storePageObjectName(job.merchantId, pageId);
    const stub = env.STORE_PAGES.get(env.STORE_PAGES.idFromName(name));
    const response = await stub.fetch('https://do.internal/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchantId: job.merchantId, pageId, settings }),
    });
    if (!response.ok) throw new Error(`StorePageDO settings sync failed: ${response.status}`);
  }));
}

async function dispatch(env: Bindings, job: QueueJob): Promise<'complete' | 'busy'> {
  const claim = await claimQueueJob(env, job);
  if (claim === 'processed') return 'complete';
  if (claim === 'busy') return 'busy';
  try {
    switch (job.type) {
      case 'meta.webhook':
        await processMetaJob(env, job);
        break;
      case 'payment.validate':
        await processPaymentJob(env, job);
        break;
      case 'catalog.reindex':
        await processCatalogJob(env, job);
        break;
      case 'order.status.dispatch':
        await processOrderStatusJob(env, job);
        break;
      case 'settings.cache.refresh':
        await processSettingsCacheJob(env, job);
        break;
    }
    await finishQueueJob(env, job.eventId, 'processed');
    return 'complete';
  } catch (error) {
    await finishQueueJob(env, job.eventId, 'failed', String(error).slice(0, 500));
    if (job.type === 'meta.webhook') {
      await markWebhook(env.DB, 'meta', job.eventId, 'failed', String(error).slice(0, 500));
    } else if (job.type === 'payment.validate') {
      await markWebhook(env.DB, 'sslcommerz', job.eventId, 'failed', String(error).slice(0, 500));
    }
    throw error;
  }
}

export async function consumeQueue(batch: MessageBatch<QueueJob>, env: Bindings): Promise<void> {
  for (const message of batch.messages) {
    try {
      const result = await dispatch(env, message.body);
      if (result === 'busy') message.retry({ delaySeconds: 90 });
      else message.ack();
    } catch (error) {
      console.error('Queue job failed', message.body.type, message.body.eventId, error);
      message.retry();
    }
  }
}
