import type { Bindings } from './env';

export function flag(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

export function isDevelopment(env: Bindings): boolean {
  return flag(env.DEV_MODE) && (env.ENVIRONMENT ?? 'local') !== 'production';
}

export function isSchemaReady(env: Bindings): boolean {
  return isDevelopment(env) || env.D1_SCHEMA_READY === 'true';
}

/**
 * Password authentication is a break-glass compatibility path, not a public
 * seller sign-in method. It stays unavailable unless an operator enables it
 * explicitly for a local session or a time-bounded recovery procedure.
 */
export function isPasswordFallbackEnabled(env: Bindings): boolean {
  return flag(env.AUTH_PASSWORD_FALLBACK_ENABLED);
}

export function requiredSecret(
  env: Bindings,
  key: keyof Bindings,
): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required secret: ${String(key)}`);
  }
  return value;
}

export function numberSetting(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
