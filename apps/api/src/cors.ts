import { cors } from 'hono/cors';
import type { Bindings } from './env';

export const BROWSER_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'X-Request-Id',
  'X-Dev-Merchant-Id',
  'X-Auth-Return-Redirect',
];

export function dashboardCors() {
  return cors({
    origin: (origin, c) => {
      const env = c.env as Bindings;
      const allowed = (env.DASHBOARD_ORIGIN ?? 'http://localhost:5173')
        .split(',')
        .map((value: string) => value.trim());
      return allowed.includes(origin) ? origin : '';
    },
    allowHeaders: BROWSER_ALLOWED_HEADERS,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 600,
  });
}
