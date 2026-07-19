import type { Context } from 'hono';
import { ApiError } from './errors';

export function validationHook(
  result: { success: boolean; error?: { issues?: unknown } },
  _c: Context<any>,
) {
  if (!result.success) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      'Request validation failed',
      result.error?.issues ?? [],
    );
  }
}
