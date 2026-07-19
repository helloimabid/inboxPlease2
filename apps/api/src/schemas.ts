import { z } from 'zod';

export const identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const pageId = z.string().trim().min(1).max(128);
export const currency = z.string().trim().length(3).transform((value) => value.toUpperCase());
export const moneyMinor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const productQuerySchema = paginationSchema.extend({
  pageId: pageId.optional(),
  status: z.enum(['active', 'draft', 'archived']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const productVariantSchema = z.object({
  id: z.uuid().optional(),
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(160),
  priceMinor: moneyMinor,
  stock: z.number().int().min(0).max(10_000_000).default(0),
});

export const createProductSchema = z.object({
  pageId,
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).default(''),
  priceMinor: moneyMinor,
  currency: currency.default('BDT'),
  stock: z.number().int().min(0).max(10_000_000).default(0),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  variants: z.array(productVariantSchema).max(50).default([]),
});

export const updateProductSchema = z.object({
  sku: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10_000).optional(),
  priceMinor: moneyMinor.optional(),
  currency: currency.optional(),
  stock: z.number().int().min(0).max(10_000_000).optional(),
  status: z.enum(['active', 'draft', 'archived']).optional(),
  variants: z.array(productVariantSchema).max(50).optional(),
})
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const orderQuerySchema = paginationSchema.extend({
  status: z.enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']).optional(),
});

export const createOrderSchema = z.object({
  pageId,
  customerPsid: z.string().trim().min(1).max(128),
  currency: currency.default('BDT'),
  items: z.array(z.object({
    productId: identifier,
    quantity: z.number().int().min(1).max(100),
  })).min(1).max(100),
  shippingAddress: z.record(z.string(), z.unknown()).default({}),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']),
});

export const checkoutCustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  phone: z.string().trim().min(6).max(30),
  address: z.string().trim().min(1).max(250),
  city: z.string().trim().min(1).max(100),
  postcode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(2).max(80).default('Bangladesh'),
});

export const updateSettingsSchema = z.object({
  assistantName: z.string().trim().min(1).max(80),
  storeDescription: z.string().trim().max(5_000),
  defaultLanguage: z.enum(['auto', 'bn', 'en', 'banglish']),
  tone: z.enum(['friendly', 'professional', 'concise']),
  currency: currency,
  businessHours: z.record(z.string(), z.unknown()),
  escalationCartThresholdMinor: moneyMinor,
});

export type ProductInput = z.infer<typeof createProductSchema>;
export type ProductUpdate = z.infer<typeof updateProductSchema>;
export type SettingsInput = z.infer<typeof updateSettingsSchema>;
