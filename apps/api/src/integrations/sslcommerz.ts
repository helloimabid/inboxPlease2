import { createHash } from 'node:crypto';
import type { Bindings } from '../env';
import { constantTimeEqual } from '../security';

export interface ExpectedPayment {
  orderId: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
}

export interface PaymentValidationResult {
  valid: boolean;
  reason?: string;
  providerStatus?: string;
  cardType?: string;
  bankTransactionId?: string;
}

export interface CheckoutCustomer {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postcode: string;
  country: string;
}

export interface CheckoutOrder {
  orderId: string;
  transactionId: string;
  amountMinor: number;
  currency: string;
}

export interface CheckoutSession {
  gatewayPageUrl: string;
  sessionKey: string | null;
}

export function formatBdtAmount(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('BDT amount must be a positive integer in paisa');
  }
  const taka = Math.floor(amountMinor / 100);
  const paisa = amountMinor % 100;
  return `${taka}.${paisa.toString().padStart(2, '0')}`;
}

export async function createSslCommerzCheckout(
  env: Bindings,
  order: CheckoutOrder,
  customer: CheckoutCustomer,
): Promise<CheckoutSession> {
  if (!env.SSLCOMMERZ_STORE_ID || !env.SSLCOMMERZ_STORE_PASSWORD) {
    throw new Error('SSLCommerz credentials are not configured');
  }
  if (order.currency !== 'BDT') throw new Error('SSLCommerz checkout only supports BDT');
  const callbackBase = env.PUBLIC_API_BASE_URL;
  if (!callbackBase) throw new Error('PUBLIC_API_BASE_URL is not configured');
  const callbackUrl = new URL('/webhooks/sslcommerz', callbackBase);
  if (callbackUrl.protocol !== 'https:' && callbackUrl.hostname !== 'localhost') {
    throw new Error('SSLCommerz callbacks require HTTPS outside localhost');
  }
  const body = new URLSearchParams({
    store_id: env.SSLCOMMERZ_STORE_ID,
    store_passwd: env.SSLCOMMERZ_STORE_PASSWORD,
    total_amount: formatBdtAmount(order.amountMinor),
    currency: 'BDT',
    tran_id: order.transactionId,
    success_url: callbackUrl.toString(),
    fail_url: callbackUrl.toString(),
    cancel_url: callbackUrl.toString(),
    ipn_url: callbackUrl.toString(),
    shipping_method: 'NO',
    product_name: `InboxPlease order ${order.orderId}`,
    product_category: 'General',
    product_profile: 'general',
    cus_name: customer.name,
    cus_email: customer.email,
    cus_add1: customer.address,
    cus_city: customer.city,
    cus_postcode: customer.postcode,
    cus_country: customer.country,
    cus_phone: customer.phone,
    value_a: order.orderId,
  });
  const endpoint = env.SSLCOMMERZ_INIT_URL ??
    'https://securepay.sslcommerz.com/gwprocess/v4/api.php';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) throw new Error(`SSLCommerz checkout failed: HTTP ${response.status}`);
  const payload = await response.json<Record<string, unknown>>();
  const status = textField(payload, 'status').toUpperCase();
  const gatewayPageUrl = textField(payload, 'GatewayPageURL');
  if (status !== 'SUCCESS' || !gatewayPageUrl) {
    throw new Error(`SSLCommerz checkout rejected: ${textField(payload, 'failedreason') || status || 'unknown'}`);
  }
  const sessionKey = textField(payload, 'sessionkey');
  return { gatewayPageUrl, sessionKey: sessionKey || null };
}

export function parseAmountMinor(value: string, currency: string): number | null {
  if (currency.toUpperCase() !== 'BDT' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

export function verifySslCommerzIpnHash(
  payload: Readonly<Record<string, string>>,
  storePassword: string,
): boolean {
  const supplied = payload.verify_sign?.toLowerCase();
  const verifyKey = payload.verify_key;
  if (!supplied || !/^[a-f0-9]{32}$/.test(supplied) || !verifyKey || !storePassword) {
    return false;
  }
  const keys = [...new Set(verifyKey.split(',').map((key) => key.trim()).filter(Boolean))];
  if (
    keys.length === 0 || keys.length > 100 ||
    keys.some((key) => !/^[A-Za-z0-9_]+$/.test(key) || !(key in payload))
  ) return false;
  const signedValues: Record<string, string> = {};
  for (const key of keys) signedValues[key] = payload[key] ?? '';
  signedValues.store_passwd = md5(storePassword);
  const serialized = Object.keys(signedValues)
    .sort()
    .map((key) => `${key}=${signedValues[key] ?? ''}`)
    .join('&');
  return constantTimeEqual(md5(serialized), supplied);
}

export async function validateSslCommerzPayment(
  env: Bindings,
  valId: string,
  expected: ExpectedPayment,
): Promise<PaymentValidationResult> {
  if (!env.SSLCOMMERZ_STORE_ID || !env.SSLCOMMERZ_STORE_PASSWORD) {
    throw new Error('SSLCommerz credentials are not configured');
  }
  const endpoint = env.SSLCOMMERZ_VALIDATION_URL ??
    'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php';
  const url = new URL(endpoint);
  url.searchParams.set('val_id', valId);
  url.searchParams.set('store_id', env.SSLCOMMERZ_STORE_ID);
  url.searchParams.set('store_passwd', env.SSLCOMMERZ_STORE_PASSWORD);
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`SSLCommerz validation failed: HTTP ${response.status}`);
  const payload = await response.json<Record<string, unknown>>();
  const providerStatus = textField(payload, 'status').toUpperCase();
  if (!['VALID', 'VALIDATED'].includes(providerStatus)) {
    return { valid: false, reason: 'provider_status', providerStatus };
  }
  if (textField(payload, 'tran_id') !== expected.transactionId) {
    return { valid: false, reason: 'transaction_mismatch', providerStatus };
  }
  if (textField(payload, 'value_a') !== expected.orderId) {
    return { valid: false, reason: 'order_mismatch', providerStatus };
  }
  const currency = textField(payload, 'currency').toUpperCase();
  if (currency !== expected.currency.toUpperCase()) {
    return { valid: false, reason: 'currency_mismatch', providerStatus };
  }
  const amountMinor = parseAmountMinor(textField(payload, 'amount'), currency);
  if (amountMinor !== expected.amountMinor) {
    return { valid: false, reason: 'amount_mismatch', providerStatus };
  }
  const riskLevel = textField(payload, 'risk_level');
  if (riskLevel && riskLevel !== '0') {
    return { valid: false, reason: 'risk_rejected', providerStatus };
  }
  const validResult: PaymentValidationResult = {
    valid: true,
    providerStatus,
  };
  const cardType = textField(payload, 'card_type');
  const bankTransactionId = textField(payload, 'bank_tran_id');
  if (cardType) validResult.cardType = cardType;
  if (bankTransactionId) validResult.bankTransactionId = bankTransactionId;
  return validResult;
}
