import { api, uploadProductImage } from './api';
import type { DashboardData, Order, Product, ProductStatus } from './types';

interface ApiEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

interface CatalogProduct {
  id: string;
  pageId: string;
  sku: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  stock: number;
  status: 'active' | 'draft' | 'archived';
  image: { id: string } | null;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    priceMinor: number;
    stock: number;
    position: number;
    image: { id: string } | null;
  }>;
  createdAt: number;
  updatedAt: number;
}

interface CatalogPayload {
  items: CatalogProduct[];
  pagination: { limit: number; offset: number };
}

interface ApiOrder {
  id: string;
  pageId: string;
  customerPsid: string;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
  paymentStatus: 'paid' | 'pending' | 'failed' | 'refunded' | 'unpaid';
  totalMinor: number;
  currency: string;
  createdAt: number;
  updatedAt: number;
}

interface OrdersPayload {
  items: ApiOrder[];
  pagination: { limit: number; offset: number };
}

export type LiveOrder = Order & { rawStatus?: ApiOrder['status']; rawCurrency?: string };
type LiveProduct = Product & { rawCurrency?: string };

const PRODUCT_ACCENTS = ['#e7eafe', '#e5f2ee', '#f4e9e4', '#eee9f6', '#e7eff6', '#f5eadf'];

function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope || envelope.ok !== true || !envelope.data) {
    throw new Error('The dashboard API returned an unexpected response');
  }
  return envelope.data;
}

function planName(value: string): DashboardData['merchant']['plan'] {
  if (value.toLowerCase() === 'enterprise') return 'Enterprise';
  if (value.toLowerCase() === 'business') return 'Business';
  if (value.toLowerCase() === 'pro') return 'Pro';
  return 'Free';
}

function planLimits(plan: DashboardData['merchant']['plan']) {
  // Enterprise entitlements are contract-specific. Infinity is an internal
  // sentinel; the live UI renders it as "Custom" instead of inventing quotas.
  if (plan === 'Enterprise') {
    return {
      messages: Number.POSITIVE_INFINITY,
      products: Number.POSITIVE_INFINITY,
      pages: Number.POSITIVE_INFINITY,
    };
  }
  if (plan === 'Business') return { messages: 20_000, products: Number.POSITIVE_INFINITY, pages: 10 };
  if (plan === 'Pro') return { messages: 3_000, products: 100, pages: 3 };
  return { messages: 200, products: 10, pages: 1 };
}

function productStatus(product: CatalogProduct): ProductStatus {
  if (product.status === 'draft') return 'draft';
  if (product.stock === 0) return 'out-of-stock';
  if (product.stock <= 5) return 'low-stock';
  return 'active';
}

function mapProduct(product: CatalogProduct, index: number): LiveProduct {
  return {
    id: product.id,
    pageId: product.pageId,
    name: product.name,
    banglaName: product.description,
    sku: product.sku,
    category: product.status === 'draft' ? 'Drafts' : 'Products',
    price: product.priceMinor / 100,
    stock: product.stock,
    sales: 0,
    status: productStatus(product),
    accent: PRODUCT_ACCENTS[index % PRODUCT_ACCENTS.length],
    glyph: product.name.trim().charAt(0).toUpperCase() || 'P',
    rawCurrency: product.currency,
    rawStatus: product.status,
    description: product.description,
    imageId: product.image?.id,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      sku: variant.sku,
      price: variant.priceMinor / 100,
      stock: variant.stock,
      imageId: variant.image?.id,
    })),
  };
}

function mapOrderStatus(status: ApiOrder['status']): Order['status'] {
  if (status === 'pending') return 'new';
  if (status === 'refunded') return 'cancelled';
  return status;
}

function mapPaymentStatus(status: ApiOrder['paymentStatus']): Order['payment'] {
  const labels: Record<ApiOrder['paymentStatus'], Exclude<Order['payment'], 'COD'>> = {
    paid: 'Paid',
    pending: 'Pending',
    failed: 'Failed',
    refunded: 'Refunded',
    unpaid: 'Unpaid',
  };
  return labels[status];
}

function formatOrderDate(value: number): string {
  const date = new Date(value > 10_000_000_000 ? value : value * 1_000);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-BD', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function mapOrder(order: ApiOrder): LiveOrder {
  return {
    id: order.id,
    customer: 'Messenger customer',
    initials: 'MC',
    items: 'Item details are available from the full order record',
    total: order.totalMinor / 100,
    status: mapOrderStatus(order.status),
    payment: mapPaymentStatus(order.paymentStatus),
    createdAt: formatOrderDate(order.createdAt),
    rawStatus: order.status,
    rawCurrency: order.currency,
  };
}

function currentUsagePeriod() {
  const now = new Date();
  const reset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    period: new Intl.DateTimeFormat('en-BD', { month: 'long', year: 'numeric' }).format(now),
    resetDate: new Intl.DateTimeFormat('en-BD', { month: 'long', day: 'numeric', year: 'numeric' }).format(reset),
  };
}

/**
 * The summary endpoint intentionally does not return customer content. This
 * hydrates only the safe live lists that currently have API support and strips
 * every remaining demo-only record before showing an authenticated account.
 */
export async function loadLiveDashboardData(summary: DashboardData): Promise<DashboardData> {
  const [catalogResult, ordersResult] = await Promise.all([
    api.get<ApiEnvelope<CatalogPayload>>('/catalog?limit=100&offset=0'),
    api.get<ApiEnvelope<OrdersPayload>>('/orders?limit=50&offset=0'),
  ]);
  const plan = planName(summary.merchant.plan);
  const limits = planLimits(plan);
  const period = currentUsagePeriod();
  const catalogItems = unwrap(catalogResult).items;
  const products = catalogItems
    .filter((product) => product.status !== 'archived')
    .map(mapProduct);
  const orders = unwrap(ordersResult).items.map(mapOrder);
  const revenueMetric = summary.metrics.find((metric) => metric.id === 'revenue');
  const ordersMetric = summary.metrics.find((metric) => metric.id === 'orders');
  const connectedPageCount = summary.pages.filter((page) => page.status === 'connected').length;

  return {
    ...summary,
    merchant: { ...summary.merchant, plan },
    metrics: [
      { id: 'revenue', label: 'Paid revenue (BDT)', value: revenueMetric?.value ?? '৳0', delta: 0, helper: 'Recorded paid orders' },
      { id: 'orders', label: 'All orders', value: ordersMetric?.value ?? String(orders.length), delta: 0, helper: ordersMetric?.helper ?? 'Recorded orders' },
      { id: 'conversations', label: 'AI messages', value: String(summary.usage.messagesUsed), delta: 0, helper: period.period },
      {
        id: 'pages',
        label: 'Facebook pages',
        value: String(summary.pages.length),
        delta: 0,
        helper: connectedPageCount
          ? `${connectedPageCount} connected to workspace`
          : summary.pages.length
            ? 'Page record needs attention'
            : 'Not connected yet',
      },
    ],
    conversations: [],
    orders,
    products,
    activities: [],
    revenue: Array.from({ length: 14 }, () => 0),
    usage: {
      ...summary.usage,
      messagesLimit: limits.messages,
      productsUsed: summary.usage.productsUsed,
      productsLimit: limits.products,
      pagesUsed: summary.pages.length,
      pagesLimit: limits.pages,
      period: period.period,
      resetDate: period.resetDate,
      qwenShare: 0,
      frontierShare: 0,
      voiceNotes: 0,
      daily: Array.from({ length: 14 }, () => 0),
      catalogLoaded: products.length,
      catalogTruncated: summary.usage.productsUsed > products.length,
    },
  };
}

export function liveOrderStatus(order: Order): string {
  return (order as LiveOrder).rawStatus ?? order.status;
}

export function liveRecordCurrency(record: Order | Product): string {
  return (record as LiveOrder | LiveProduct).rawCurrency ?? 'BDT';
}

export interface LiveVariantInput {
  id?: string;
  sku: string;
  name: string;
  priceMinor: number;
  stock: number;
  imageFile?: File;
}

export interface LiveProductInput {
  pageId: string;
  sku: string;
  name: string;
  description: string;
  priceMinor: number;
  stock: number;
  variants: LiveVariantInput[];
  imageFile?: File;
}

type CatalogWriteInput = Omit<LiveProductInput, 'imageFile' | 'variants'> & {
  variants: Array<Omit<LiveVariantInput, 'imageFile'>>;
};

async function uploadCatalogImages(
  product: CatalogProduct,
  input: LiveProductInput,
): Promise<void> {
  const uploads: Promise<void>[] = [];
  if (input.imageFile) uploads.push(uploadProductImage(product.id, input.imageFile));
  input.variants.forEach((variant, index) => {
    const savedVariant = variant.id
      ? product.variants.find(({ id }) => id === variant.id)
      : product.variants[index];
    if (variant.imageFile && savedVariant) {
      uploads.push(uploadProductImage(product.id, variant.imageFile, savedVariant.id));
    }
  });
  await Promise.all(uploads);
}

export async function createLiveProduct(input: LiveProductInput): Promise<void> {
  const payload: CatalogWriteInput & { currency: string; status: 'active' } = {
    pageId: input.pageId,
    sku: input.sku,
    name: input.name,
    description: input.description,
    priceMinor: input.priceMinor,
    stock: input.stock,
    variants: input.variants.map(({ imageFile: _imageFile, ...variant }) => variant),
    currency: 'BDT',
    status: 'active',
  };
  const result = await api.post<ApiEnvelope<CatalogProduct>, typeof payload>(
    '/catalog',
    payload,
  );
  await uploadCatalogImages(unwrap(result), input);
}

export async function updateLiveProduct(productId: string, input: LiveProductInput): Promise<void> {
  const payload = {
    sku: input.sku,
    name: input.name,
    description: input.description,
    priceMinor: input.priceMinor,
    stock: input.stock,
    variants: input.variants.map(({ imageFile: _imageFile, ...variant }) => variant),
    currency: 'BDT',
  };
  const result = await api.put<ApiEnvelope<CatalogProduct>, typeof payload>(
    `/catalog/${encodeURIComponent(productId)}`,
    payload,
  );
  await uploadCatalogImages(unwrap(result), input);
}

export async function deleteLiveProduct(productId: string): Promise<void> {
  await api.delete<ApiEnvelope<{ archived: true }>>(
    `/catalog/${encodeURIComponent(productId)}`,
  );
}
