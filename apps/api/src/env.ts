export interface Bindings {
  DB: D1Database;
  CUSTOMER_THREADS: DurableObjectNamespace;
  STORE_PAGES: DurableObjectNamespace;
  JOBS: Queue<QueueJob>;
  MEDIA: R2Bucket;
  VECTORIZE_CATALOG: VectorizeIndex;
  AI: Ai;

  ENVIRONMENT?: string;
  DEV_MODE?: string;
  D1_SCHEMA_READY?: string;
  DASHBOARD_ORIGIN?: string;
  AUTH_URL?: string;
  AUTH_SECRET?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_FACEBOOK_ID?: string;
  AUTH_FACEBOOK_SECRET?: string;
  AUTH_PASSWORD_FALLBACK_ENABLED?: string;

  AI_ENABLED?: string;
  AI_GATEWAY_ID?: string;
  DEFAULT_AI_MODEL?: string;
  FRONTIER_AI_MODEL?: string;
  VISION_AI_MODEL?: string;
  WHISPER_AI_MODEL?: string;
  EMBEDDING_AI_MODEL?: string;
  VECTOR_SEARCH_ENABLED?: string;
  VECTOR_COSINE_THRESHOLD?: string;

  MESSAGING_ENABLED?: string;
  META_GRAPH_VERSION?: string;
  /** Messenger-capable Meta app used for Page authorization and webhooks. */
  META_APP_ID?: string;
  META_VERIFY_TOKEN?: string;
  /** Secret for the Messenger-capable Meta app. */
  META_APP_SECRET?: string;
  META_PAGE_ACCESS_TOKEN?: string;
  META_TOKEN_ENCRYPTION_KEY?: string;
  META_PRIMARY_RECEIVER_ID?: string;
  META_HANDOVER_TARGET_APP_ID?: string;
  HANDOFF_ON_COMPLAINT?: string;
  PROACTIVE_ORDER_UPDATES_ENABLED?: string;

  PAYMENTS_ENABLED?: string;
  SSLCOMMERZ_STORE_ID?: string;
  SSLCOMMERZ_STORE_PASSWORD?: string;
  SSLCOMMERZ_INIT_URL?: string;
  SSLCOMMERZ_VALIDATION_URL?: string;
  PUBLIC_API_BASE_URL?: string;
}

export interface AuthContext {
  merchantId: string;
  subject: string;
  role: 'owner' | 'admin' | 'staff' | 'service';
  source: 'session' | 'development';
  /** Facebook profile used to create the current Auth.js login session. */
  facebookAccountId?: string;
}

export interface AppVariables {
  auth: AuthContext;
  requestId: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};

export type MetaQueueJob = {
  type: 'meta.webhook';
  eventId: string;
  payload: MetaWebhookPayload;
};

export type PaymentQueueJob = {
  type: 'payment.validate';
  eventId: string;
  payload: Record<string, string>;
};

export type CatalogQueueJob = {
  type: 'catalog.reindex';
  eventId: string;
  merchantId: string;
  pageId: string;
  productId: string;
  operation: 'upsert' | 'delete';
};

export type OrderStatusQueueJob = {
  type: 'order.status.dispatch';
  eventId: string;
  merchantId: string;
  orderId: string;
  status: 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
};

export type SettingsCacheQueueJob = {
  type: 'settings.cache.refresh';
  eventId: string;
  merchantId: string;
};

export type QueueJob =
  | MetaQueueJob
  | PaymentQueueJob
  | CatalogQueueJob
  | OrderStatusQueueJob
  | SettingsCacheQueueJob;

export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: MetaMessagingEvent[];
  }>;
}

export interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; sticker_id?: number };
    }>;
  };
  postback?: { mid?: string; title?: string; payload?: string };
  delivery?: unknown;
  read?: unknown;
  pass_thread_control?: unknown;
  take_thread_control?: unknown;
  request_thread_control?: unknown;
}
