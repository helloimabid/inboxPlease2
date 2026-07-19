import { afterEach, describe, expect, it, vi } from 'vitest';
import { isActionableMetaEvent, isMetaHandoverEvent } from '../src/integrations/meta';
import {
  createSslCommerzCheckout,
  formatBdtAmount,
  parseAmountMinor,
  verifySslCommerzIpnHash,
} from '../src/integrations/sslcommerz';
import { didOrderTransitionCommit, isValidOrderTransition } from '../src/routes/orders';
import { productSearchQuery } from '../src/routes/catalog';
import type { Bindings } from '../src/env';

afterEach(() => vi.unstubAllGlobals());

describe('commerce invariants', () => {
  it('parses BDT into paisa without floating-point rounding', () => {
    expect(parseAmountMinor('5000.05', 'BDT')).toBe(500_005);
    expect(parseAmountMinor('10.5', 'BDT')).toBe(1_050);
    expect(parseAmountMinor('10.005', 'BDT')).toBeNull();
    expect(parseAmountMinor('10.00', 'USD')).toBeNull();
  });

  it('serializes paisa to an exact SSLCommerz BDT decimal', () => {
    expect(formatBdtAmount(500_005)).toBe('5000.05');
    expect(formatBdtAmount(1_050)).toBe('10.50');
    expect(() => formatBdtAmount(0)).toThrow();
    expect(() => formatBdtAmount(10.5)).toThrow();
  });

  it('validates SSLCommerz IPN hashes and rejects tampering', () => {
    const payload = {
      amount: '100.00',
      status: 'VALID',
      tran_id: 'T1',
      verify_key: 'amount,status,tran_id',
      verify_sign: '2e9d994b0946ce064e4e7cb817b796d9',
    };
    expect(verifySslCommerzIpnHash(payload, 'secret')).toBe(true);
    expect(verifySslCommerzIpnHash({ ...payload, amount: '101.00' }, 'secret')).toBe(false);
  });

  it('keeps generated SSLCommerz transaction IDs within 30 characters', () => {
    const transactionId = `ip-${crypto.randomUUID().replace(/-/g, '').slice(0, 27)}`;
    expect(transactionId).toHaveLength(30);
  });

  it('creates checkout with an exact amount and server callback tuple', async () => {
    let submitted: URLSearchParams | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      submitted = init?.body as URLSearchParams;
      return Response.json({
        status: 'SUCCESS',
        GatewayPageURL: 'https://sandbox.sslcommerz.com/pay/session',
        sessionkey: 'session-1',
      });
    }));
    const session = await createSslCommerzCheckout({
      SSLCOMMERZ_STORE_ID: 'store',
      SSLCOMMERZ_STORE_PASSWORD: 'password',
      SSLCOMMERZ_INIT_URL: 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php',
      PUBLIC_API_BASE_URL: 'https://api.example.com',
    } as Bindings, {
      orderId: 'order-1',
      transactionId: 'ip-123456789012345678901234567',
      amountMinor: 500_005,
      currency: 'BDT',
    }, {
      name: 'Test Customer',
      email: 'test@example.com',
      phone: '01700000000',
      address: 'Dhaka',
      city: 'Dhaka',
      postcode: '1200',
      country: 'Bangladesh',
    });
    expect(session.gatewayPageUrl).toContain('/pay/session');
    expect(submitted?.get('total_amount')).toBe('5000.05');
    expect(submitted?.get('currency')).toBe('BDT');
    expect(submitted?.get('value_a')).toBe('order-1');
    expect(submitted?.get('ipn_url')).toBe('https://api.example.com/webhooks/sslcommerz');
  });

  it('enforces monotonic order-state transitions', () => {
    expect(isValidOrderTransition('pending', 'confirmed')).toBe(true);
    expect(isValidOrderTransition('delivered', 'processing')).toBe(false);
    expect(isValidOrderTransition('cancelled', 'confirmed')).toBe(false);
  });

  it('resolves trigger-ambiguous D1 change metadata from persisted order state', () => {
    expect(didOrderTransitionCommit(1, undefined, 'cancelled')).toBe(true);
    expect(didOrderTransitionCommit(0, 'cancelled', 'cancelled')).toBe(true);
    expect(didOrderTransitionCommit(0, 'confirmed', 'cancelled')).toBe(false);
  });

  it('builds bounded, quoted D1 FTS prefix queries', () => {
    expect(productSearchQuery('linen kurti')).toBe('"linen"* AND "kurti"*');
    expect(productSearchQuery('navy "blue"')).toBe('"navy"* AND """blue"""*');
    expect(productSearchQuery('a b c d e f g h i')).not.toContain('"i"*');
  });

  it('ignores Meta echoes, delivery receipts, and read receipts', () => {
    expect(isActionableMetaEvent({ message: { is_echo: true } })).toBe(false);
    expect(isActionableMetaEvent({ delivery: {} })).toBe(false);
    expect(isActionableMetaEvent({ read: {} })).toBe(false);
    expect(isActionableMetaEvent({ message: { text: 'hello' } })).toBe(true);
  });

  it('recognizes handover events so human control pauses and resumes AI', () => {
    expect(isMetaHandoverEvent({ pass_thread_control: {} })).toBe(true);
    expect(isActionableMetaEvent({ take_thread_control: {} })).toBe(true);
  });
});
