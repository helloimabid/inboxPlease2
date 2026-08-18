import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { requireAuth } from './auth';
import { authJsRoutes, initAuthJs } from './authjs';
import { isSchemaReady } from './config';
import { dashboardCors } from './cors';
import { ApiError, errorResponse } from './errors';
import type { AppEnv, Bindings } from './env';
import { sweepOutbox } from './outbox';
import { consumeQueue } from './queue';
import { accountRoutes, authAccountRoutes } from './routes/auth-accounts';
import { catalogRoutes } from './routes/catalog';
import { dashboardRoutes } from './routes/dashboard';
import {
  cleanupExpiredMetaOnboarding,
  facebookCallbackRoutes,
  facebookRoutes,
  reconcileFacebookPageSubscriptions,
} from './routes/facebook';
import { healthRoutes } from './routes/health';
import { mediaRoutes } from './routes/media';
import { ordersRoutes } from './routes/orders';
import { settingsRoutes } from './routes/settings';
import { webhookRoutes } from './routes/webhooks';
import { assertReadySchema, requireReadySchema } from './schema-readiness';

export { CustomerThreadDO } from './durable/customer-thread';
export { StorePageDO } from './durable/store-page';

const app = new Hono<AppEnv>()
  .use(
  '*',
  secureHeaders({
    crossOriginResourcePolicy: 'cross-origin',
  })
)
  .use('*', async (c, next) => {
    const requestId = c.req.header('X-Request-Id')?.slice(0, 128) ?? crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
    // Log the path only. Query strings may contain Meta verification secrets.
    console.log(JSON.stringify({
      type: 'http_request',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      requestId,
    }));
  })
  .use('*', dashboardCors())
  .use('*', initAuthJs)
  .use('*', requireReadySchema)
  .route('/authjs', authJsRoutes)
  .route('/health', healthRoutes)
  .route('/auth', authAccountRoutes)
  .route('/webhooks', webhookRoutes)
  .use('/facebook/*', requireAuth)
  .route('/facebook', facebookCallbackRoutes)
  .use('/api/*', requireAuth)
  .route('/api/account', accountRoutes)
  .route('/api/dashboard', dashboardRoutes)
  .route('/api/catalog', catalogRoutes)
  .route('/api/orders', ordersRoutes)
  .route('/api/settings', settingsRoutes)
  .route('/api/media', mediaRoutes)
  .route('/api/facebook', facebookRoutes);

app.notFound((_c) => {
  throw new ApiError(404, 'NOT_FOUND', 'Route was not found');
});

app.onError((error, c) => errorResponse(c, error));

export type AppType = typeof app;
export { app };

export default {
  fetch: app.fetch,
  queue: (batch, env) => {
    assertReadySchema(env);
    return consumeQueue(batch as MessageBatch<import('./env').QueueJob>, env);
  },
  scheduled: (_controller, env, ctx) => {
    if (!isSchemaReady(env)) {
      console.error('D1 schema is not ready; scheduled outbox sweep blocked');
      return;
    }
    ctx.waitUntil(sweepOutbox(env).then((result) => {
      if (result.selected > 0) {
        console.log(JSON.stringify({ type: 'outbox_sweep', ...result }));
      }
    }));
    ctx.waitUntil(cleanupExpiredMetaOnboarding(env).catch((error) => {
      console.error('Expired Facebook onboarding cleanup failed', error);
    }));
    ctx.waitUntil(reconcileFacebookPageSubscriptions(env).then((result) => {
      if (result.selected > 0) {
        console.log(JSON.stringify({ type: 'facebook_page_reconcile', ...result }));
      }
    }).catch((error) => {
      console.error('Facebook Page subscription reconciliation failed', error);
    }));
  },
} satisfies ExportedHandler<Bindings>;
