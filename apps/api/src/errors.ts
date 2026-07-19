import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './env';

export class ApiError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly details?: unknown;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorResponse(c: Context<AppEnv>, error: unknown): Response {
  const known = error instanceof ApiError;
  const status: ContentfulStatusCode = known ? error.status : 500;
  const code = known ? error.code : 'INTERNAL_ERROR';
  const message = known ? error.message : 'An unexpected error occurred';

  if (!known) console.error('Unhandled API error', error);

  return c.json(
    {
      ok: false as const,
      error: {
        code,
        message,
        ...(known && error.details !== undefined
          ? { details: error.details }
          : {}),
      },
      requestId: c.get('requestId'),
    },
    status,
  );
}

export function jsonOk<T>(c: Context<AppEnv>, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true as const, data, requestId: c.get('requestId') }, status);
}
