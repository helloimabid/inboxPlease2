import { describe, expect, it } from 'vitest';
import type { OrderStatusQueueJob, SettingsCacheQueueJob } from '../src/env';
import {
  outboxRetryDelaySeconds,
  parseOutboxJob,
  serializeOutboxJob,
} from '../src/outbox';
import { orderStatusMessage } from '../src/queue';
import { orderRequestFingerprint } from '../src/routes/orders';

describe('transactional outbox', () => {
  it('round-trips a queue job only when its envelope matches', () => {
    const job: SettingsCacheQueueJob = {
      type: 'settings.cache.refresh',
      eventId: 'event-1',
      merchantId: 'merchant-1',
    };
    const row = {
      id: job.eventId,
      event_type: job.type,
      payload_json: serializeOutboxJob(job),
    };
    expect(parseOutboxJob(row)).toEqual(job);
    expect(() => parseOutboxJob({ ...row, id: 'event-2' })).toThrow(/envelope/);
  });

  it('bounds retry backoff', () => {
    expect(outboxRetryDelaySeconds(1)).toBe(2);
    expect(outboxRetryDelaySeconds(4)).toBe(16);
    expect(outboxRetryDelaySeconds(100)).toBe(256);
  });

  it('renders the immutable order-status snapshot carried by the job', () => {
    const job: OrderStatusQueueJob = {
      type: 'order.status.dispatch',
      eventId: 'status-1',
      merchantId: 'merchant-1',
      orderId: 'order-1',
      status: 'confirmed',
    };
    expect(orderStatusMessage(job)).toBe('Order order-1 is now confirmed.');
  });

  it('fingerprints normalized order meaning and detects payload changes', async () => {
    const first = {
      pageId: 'page-1',
      customerPsid: 'customer-1',
      currency: 'BDT',
      items: [
        { productId: 'product-b', quantity: 1 },
        { productId: 'product-a', quantity: 1 },
        { productId: 'product-a', quantity: 2 },
      ],
      shippingAddress: { city: 'Dhaka', details: { road: 2, house: 5 } },
    };
    const equivalent = {
      ...first,
      items: [
        { productId: 'product-a', quantity: 3 },
        { productId: 'product-b', quantity: 1 },
      ],
      shippingAddress: { details: { house: 5, road: 2 }, city: 'Dhaka' },
    };
    expect(await orderRequestFingerprint(equivalent))
      .toBe(await orderRequestFingerprint(first));
    expect(await orderRequestFingerprint({
      ...equivalent,
      items: [{ productId: 'product-a', quantity: 4 }],
    })).not.toBe(await orderRequestFingerprint(first));
  });
});
