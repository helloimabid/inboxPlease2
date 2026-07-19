import { createMiddleware } from 'hono/factory';
import { isSchemaReady } from './config';
import type { AppEnv, Bindings } from './env';
import { ApiError } from './errors';

export const requireReadySchema = createMiddleware<AppEnv>(async (c, next) => {
  if (new URL(c.req.url).pathname !== '/health' && !isSchemaReady(c.env)) {
    throw new ApiError(
      503,
      'D1_SCHEMA_NOT_READY',
      'The application database schema is not ready',
    );
  }
  await next();
});

export function assertReadySchema(env: Bindings): void {
  if (!isSchemaReady(env)) {
    throw new Error('D1 schema is not ready; background processing blocked');
  }
}

