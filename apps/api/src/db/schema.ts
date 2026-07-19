import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export type MerchantPlan = 'free' | 'pro' | 'business' | 'enterprise';
export type MerchantStatus = 'active' | 'suspended' | 'closed';
export type MembershipRole = 'owner' | 'admin' | 'staff' | 'service';
export type MembershipStatus = 'active' | 'revoked';
export type MetaSubscriptionStatus =
  | 'not_subscribed'
  | 'subscribed'
  | 'subscription_failed'
  | 'connecting'
  | 'disconnecting'
  | 'unsubscribe_failed'
  | 'disconnected';
export type MetaOnboardingStatus =
  | 'authorization_pending'
  | 'pages_ready'
  | 'completed'
  | 'permission_denied'
  | 'no_pages'
  | 'failed';

export const merchants = sqliteTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').$type<MerchantPlan>().notNull().default('free'),
  status: text('status').$type<MerchantStatus>().notNull().default('active'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
});

/**
 * Shared first-party and Auth.js identity table.
 *
 * Auth.js owns the camel-case adapter columns. Password identities additionally
 * populate the normalized email and PBKDF2 columns. Migration 0009 enforces
 * that a password digest is either complete or entirely absent.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: text('emailVerified'),
  image: text('image'),
  emailNormalized: text('email_normalized').unique(),
  passwordHash: text('password_hash'),
  passwordSalt: text('password_salt'),
  passwordIterations: integer('password_iterations'),
  status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  check(
    'users_password_digest_complete',
    sql`(${table.passwordHash} IS NULL AND ${table.passwordSalt} IS NULL
      AND ${table.passwordIterations} IS NULL)
      OR (${table.passwordHash} IS NOT NULL AND ${table.passwordSalt} IS NOT NULL
      AND ${table.passwordIterations} IS NOT NULL AND ${table.emailNormalized} IS NOT NULL)`,
  ),
]);

export const merchantMemberships = sqliteTable('merchant_memberships', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  merchantId: text('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  role: text('role').$type<MembershipRole>().notNull(),
  status: text('status').$type<MembershipStatus>().notNull().default('active'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.userId, table.merchantId] }),
  index('idx_memberships_merchant_role').on(table.merchantId, table.status, table.role),
]);

export const authAccounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('providerAccountId').notNull(),
  refreshToken: text('refresh_token'),
  accessToken: text('access_token'),
  expiresAt: integer('expires_at'),
  tokenType: text('token_type'),
  scope: text('scope'),
  idToken: text('id_token'),
  sessionState: text('session_state'),
  oauthTokenSecret: text('oauth_token_secret'),
  oauthToken: text('oauth_token'),
}, (table) => [
  unique('accounts_provider_provider_account_unique')
    .on(table.provider, table.providerAccountId),
  index('idx_authjs_accounts_user').on(table.userId),
]);

export const authSessions = sqliteTable('sessions', {
  id: text('id').notNull().unique(),
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: text('expires').notNull(),
}, (table) => [index('idx_authjs_sessions_user').on(table.userId)]);

export const verificationTokens = sqliteTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').primaryKey(),
  expires: text('expires').notNull(),
}, (table) => [
  index('idx_authjs_verification_identifier').on(table.identifier),
]);

export const authLoginAttempts = sqliteTable('auth_login_attempts', {
  subjectHash: text('subject_hash').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStartedAt: integer('window_started_at').notNull(),
  lockedUntil: integer('locked_until').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('idx_auth_login_attempts_expiry').on(table.lockedUntil, table.updatedAt),
]);

export const storePages = sqliteTable('store_pages', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  metaPageAccessToken: text('meta_page_access_token'),
  connectedAt: integer('connected_at'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  metaSubscriptionStatus: text('meta_subscription_status')
    .$type<MetaSubscriptionStatus>().notNull().default('not_subscribed'),
  metaPermissionsJson: text('meta_permissions_json').notNull().default('[]'),
  metaTasksJson: text('meta_tasks_json').notNull().default('[]'),
  messagingReadyAt: integer('messaging_ready_at'),
  aiMessagingEnabled: integer('ai_messaging_enabled', { mode: 'boolean' })
    .notNull().default(false),
  aiMessagingApprovedAt: integer('ai_messaging_approved_at'),
  aiMessagingApprovedByUserId: text('ai_messaging_approved_by_user_id')
    .references(() => users.id, { onDelete: 'set null' }),
  aiMessagingDisabledAt: integer('ai_messaging_disabled_at'),
  disconnectedAt: integer('disconnected_at'),
  metaLastError: text('meta_last_error'),
  metaConnectionGeneration: integer('meta_connection_generation').notNull().default(0),
  metaOperationId: text('meta_operation_id'),
  metaOperationKind: text('meta_operation_kind').$type<'connect' | 'disconnect'>(),
  metaOperationExpiresAt: integer('meta_operation_expires_at'),
  metaSubscriptionDesired: integer('meta_subscription_desired', { mode: 'boolean' })
    .notNull().default(false),
  metaReconcileAfter: integer('meta_reconcile_after'),
  metaReconcileAttempts: integer('meta_reconcile_attempts').notNull().default(0),
  metaReconcileFailures: integer('meta_reconcile_failures').notNull().default(0),
}, (table) => [
  index('idx_store_pages_merchant').on(table.merchantId, table.id),
  index('idx_store_pages_messaging_state').on(
    table.merchantId,
    table.aiMessagingEnabled,
    table.metaSubscriptionStatus,
  ),
  index('idx_store_pages_meta_reconcile').on(
    table.metaReconcileAfter,
    table.metaOperationExpiresAt,
  ),
  check(
    'store_pages_meta_subscription_status_valid',
    sql`${table.metaSubscriptionStatus} IN (
      'not_subscribed', 'subscribed', 'subscription_failed', 'connecting',
      'disconnecting', 'unsubscribe_failed', 'disconnected'
    )`,
  ),
  check('store_pages_meta_permissions_json_valid', sql`json_valid(${table.metaPermissionsJson})`),
  check('store_pages_meta_tasks_json_valid', sql`json_valid(${table.metaTasksJson})`),
  check('store_pages_ai_messaging_enabled_valid', sql`${table.aiMessagingEnabled} IN (0, 1)`),
  check('store_pages_meta_generation_valid', sql`${table.metaConnectionGeneration} >= 0`),
  check(
    'store_pages_meta_operation_kind_valid',
    sql`${table.metaOperationKind} IS NULL OR ${table.metaOperationKind} IN ('connect', 'disconnect')`,
  ),
  check(
    'store_pages_meta_operation_complete',
    sql`(
      ${table.metaOperationId} IS NULL AND ${table.metaOperationKind} IS NULL
      AND ${table.metaOperationExpiresAt} IS NULL
    ) OR (
      ${table.metaOperationId} IS NOT NULL AND ${table.metaOperationKind} IS NOT NULL
      AND ${table.metaOperationExpiresAt} IS NOT NULL
    )`,
  ),
  check(
    'store_pages_ai_approval_complete',
    sql`${table.aiMessagingEnabled} = 0 OR (
      ${table.metaSubscriptionStatus} = 'subscribed'
      AND ${table.messagingReadyAt} IS NOT NULL
      AND ${table.aiMessagingApprovedAt} IS NOT NULL
      AND ${table.aiMessagingApprovedByUserId} IS NOT NULL
    )`,
  ),
  check('store_pages_meta_subscription_desired_valid', sql`${table.metaSubscriptionDesired} IN (0, 1)`),
  check('store_pages_meta_reconcile_attempts_valid', sql`${table.metaReconcileAttempts} >= 0`),
  check('store_pages_meta_reconcile_failures_valid', sql`${table.metaReconcileFailures} >= 0`),
]);

export const metaOnboardingSessions = sqliteTable('meta_onboarding_sessions', {
  id: text('id').primaryKey(),
  stateDigest: text('state_digest').notNull().unique(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  merchantId: text('merchant_id').notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  facebookUserId: text('facebook_user_id').notNull(),
  status: text('status').$type<MetaOnboardingStatus>()
    .notNull().default('authorization_pending'),
  requestedPermissionsJson: text('requested_permissions_json').notNull(),
  grantedPermissionsJson: text('granted_permissions_json').notNull().default('[]'),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('idx_meta_onboarding_merchant_user')
    .on(table.merchantId, table.userId, table.createdAt),
  index('idx_meta_onboarding_expiry').on(table.expiresAt, table.status),
  check(
    'meta_onboarding_sessions_status_valid',
    sql`${table.status} IN (
      'authorization_pending', 'pages_ready', 'completed',
      'permission_denied', 'no_pages', 'failed'
    )`,
  ),
  check(
    'meta_onboarding_sessions_requested_permissions_json_valid',
    sql`json_valid(${table.requestedPermissionsJson})`,
  ),
  check(
    'meta_onboarding_sessions_granted_permissions_json_valid',
    sql`json_valid(${table.grantedPermissionsJson})`,
  ),
]);

export const metaPageCandidates = sqliteTable('meta_page_candidates', {
  sessionId: text('session_id').notNull()
    .references(() => metaOnboardingSessions.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull(),
  name: text('name').notNull(),
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  tasksJson: text('tasks_json').notNull().default('[]'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.sessionId, table.pageId] }),
  index('idx_meta_page_candidates_page').on(table.pageId, table.sessionId),
  check('meta_page_candidates_tasks_json_valid', sql`json_valid(${table.tasksJson})`),
]);

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull()
    .references(() => storePages.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceMinor: integer('price_minor').notNull(),
  currency: text('currency').notNull().default('BDT'),
  stock: integer('stock').notNull().default(0),
  status: text('status').$type<'active' | 'draft' | 'archived'>().notNull().default('active'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  unique('products_merchant_sku_unique').on(table.merchantId, table.sku),
  index('idx_products_tenant_page').on(table.merchantId, table.pageId, table.status, table.updatedAt),
  check('products_price_nonnegative', sql`${table.priceMinor} >= 0`),
  check('products_stock_nonnegative', sql`${table.stock} >= 0`),
]);

export const productVariants = sqliteTable('product_variants', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  priceMinor: integer('price_minor').notNull(),
  stock: integer('stock').notNull().default(0),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (table) => [
  unique('product_variants_product_sku_unique').on(table.productId, table.sku),
  index('idx_product_variants_tenant_product')
    .on(table.merchantId, table.productId, table.position, table.createdAt),
  check('product_variants_price_nonnegative', sql`${table.priceMinor} >= 0`),
  check('product_variants_stock_nonnegative', sql`${table.stock} >= 0`),
  check('product_variants_position_nonnegative', sql`${table.position} >= 0`),
]);

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  productId: text('product_id')
    .references(() => products.id, { onDelete: 'cascade' }),
  r2Key: text('r2_key').notNull().unique(),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  variantId: text('variant_id')
    .references(() => productVariants.id, { onDelete: 'cascade' }),
  role: text('role').$type<'primary' | 'gallery'>().notNull().default('gallery'),
}, (table) => [
  index('idx_media_tenant_product').on(table.merchantId, table.productId, table.createdAt),
  index('idx_media_tenant_variant').on(table.merchantId, table.variantId, table.createdAt),
  check('media_assets_byte_size_nonnegative', sql`${table.byteSize} >= 0`),
  check('media_assets_role_valid', sql`${table.role} IN ('primary', 'gallery')`),
]);
