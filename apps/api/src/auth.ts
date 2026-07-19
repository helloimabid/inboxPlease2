import { createMiddleware } from 'hono/factory';
import { getActiveAccountIdentity } from './auth-account-service';
import { resolveAuthJsContext } from './authjs';
import { ApiError } from './errors';
import type { AppEnv, AuthContext, Bindings } from './env';
import { base64UrlDecode, utf8 } from './security';
import { isDevelopment } from './config';

interface SessionClaims {
  sub: string;
  merchant_id: string;
  role: AuthContext['role'];
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
}

function parseJsonPart<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as T;
  } catch {
    throw new ApiError(401, 'INVALID_TOKEN', 'The session token is malformed');
  }
}

function validAudience(claim: string | string[], expected: string): boolean {
  return Array.isArray(claim) ? claim.includes(expected) : claim === expected;
}

function validRole(role: unknown): role is AuthContext['role'] {
  return role === 'owner' || role === 'admin' || role === 'staff' || role === 'service';
}

export async function verifySessionToken(
  token: string,
  env: Bindings,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AuthContext> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ApiError(401, 'INVALID_TOKEN', 'The session token is malformed');
  }

  const header = parseJsonPart<{ alg?: string; typ?: string }>(parts[0]);
  if (header.alg !== 'HS256') {
    throw new ApiError(401, 'INVALID_TOKEN', 'Unsupported token algorithm');
  }

  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(parts[2]),
      utf8(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new ApiError(401, 'INVALID_TOKEN', 'The session token is malformed');
  }
  if (!verified) throw new ApiError(401, 'INVALID_TOKEN', 'Invalid token signature');

  const claims = parseJsonPart<SessionClaims>(parts[1]);
  const issuer = env.AUTH_ISSUER ?? 'inboxplease';
  const audience = env.AUTH_AUDIENCE ?? 'inboxplease-dashboard';
  if (
    !claims.sub ||
    !claims.merchant_id ||
    claims.iss !== issuer ||
    !validAudience(claims.aud, audience) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= nowSeconds ||
    (claims.nbf !== undefined && claims.nbf > nowSeconds + 30) ||
    !validRole(claims.role)
  ) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Token claims are invalid or expired');
  }

  return {
    merchantId: claims.merchant_id,
    subject: claims.sub,
    role: claims.role,
    source: 'session',
  };
}

async function ensureDevelopmentMerchant(env: Bindings, merchantId: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO merchants (id, name, plan)
     VALUES (?1, 'Local development merchant', 'business')`,
  ).bind(merchantId).run();
}

function hasAuthJsSessionCookie(cookie: string | undefined): boolean {
  return /(?:^|;\s*)(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/.test(cookie ?? '');
}

async function assertAccountActive(env: Bindings, auth: AuthContext) {
  const identity = await getActiveAccountIdentity(env, auth.subject, auth.merchantId);
  if (!identity) {
    throw new ApiError(403, 'ACCOUNT_INACTIVE', 'The account or merchant is not active');
  }
  if (identity.role !== auth.role) {
    throw new ApiError(403, 'SESSION_STALE', 'The session role is no longer current');
  }
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (authorization?.startsWith('Bearer ')) {
    const auth = await verifySessionToken(authorization.slice(7), c.env);
    await assertAccountActive(c.env, auth);
    c.set('auth', auth);
    await next();
    return;
  }

  if (hasAuthJsSessionCookie(c.req.header('Cookie'))) {
    let auth: AuthContext | null = null;
    try {
      auth = await resolveAuthJsContext(c);
    } catch {
      throw new ApiError(401, 'INVALID_SESSION', 'The Auth.js session is invalid or expired');
    }
    if (!auth) {
      throw new ApiError(401, 'INVALID_SESSION', 'The Auth.js session is invalid or expired');
    }
    await assertAccountActive(c.env, auth);
    c.set('auth', auth);
    await next();
    return;
  }

  if (isDevelopment(c.env)) {
    const merchantId = c.req.header('X-Dev-Merchant-Id') ?? 'dev-merchant';
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(merchantId)) {
      throw new ApiError(400, 'INVALID_MERCHANT_ID', 'Invalid development merchant ID');
    }
    await ensureDevelopmentMerchant(c.env, merchantId);
    c.set('auth', {
      merchantId,
      subject: 'local-developer',
      role: 'owner',
      source: 'development',
    });
    await next();
    return;
  }

  throw new ApiError(401, 'AUTH_REQUIRED', 'A valid session is required');
});

/**
 * Authorize an already authenticated dashboard identity for a route.
 *
 * Keep authentication at the `/api/*` boundary and attach this middleware to
 * individual mutations. That makes read access explicit while preventing a
 * service token from inheriting human write privileges.
 */
export function requireRole(...roles: readonly AuthContext['role'][]) {
  const allowed = new Set<AuthContext['role']>(roles);
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !allowed.has(auth.role)) {
      throw new ApiError(
        403,
        'ROLE_FORBIDDEN',
        'Your session does not have permission to perform this action',
      );
    }
    await next();
  });
}

export const MERCHANT_ADMIN_ROLES = ['owner', 'admin'] as const;
export const ORDER_MUTATION_ROLES = ['owner', 'admin', 'staff'] as const;
