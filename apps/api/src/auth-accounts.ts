import { ApiError } from './errors';
import type { AuthContext, Bindings } from './env';
import { base64Encode, sha256Name, utf8 } from './security';

export const PASSWORD_ITERATIONS = 600_000;
const PASSWORD_BYTES = 32;
const SALT_BYTES = 16;
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export interface PasswordDigest {
  hash: string;
  salt: string;
  iterations: number;
}

export interface SessionIdentity {
  userId: string;
  merchantId: string;
  role: AuthContext['role'];
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return new Uint8Array(Array.from(binary, (character) => character.charCodeAt(0)));
}

function base64Url(value: string | Uint8Array<ArrayBuffer>): string {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return base64Encode(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function constantTimeBytes(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBuffer>,
): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

async function derivePassword(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const saltCopy: Uint8Array<ArrayBuffer> = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltCopy, iterations },
    key,
    PASSWORD_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFKC').toLowerCase();
}

export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    hash: base64Encode(hash),
    salt: base64Encode(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  digest: PasswordDigest,
): Promise<boolean> {
  if (
    !Number.isInteger(digest.iterations) || digest.iterations < 100_000 ||
    digest.iterations > 2_000_000
  ) return false;
  try {
    const expected = decodeBase64(digest.hash);
    const actual = await derivePassword(password, decodeBase64(digest.salt), digest.iterations);
    return constantTimeBytes(actual, expected);
  } catch {
    return false;
  }
}

export async function signSessionToken(
  env: Bindings,
  identity: SessionIdentity,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  }
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    sub: identity.userId,
    merchant_id: identity.merchantId,
    role: identity.role,
    iss: env.AUTH_ISSUER ?? 'inboxplease',
    aud: env.AUTH_AUDIENCE ?? 'inboxplease-dashboard',
    iat: nowSeconds,
    nbf: nowSeconds - 5,
    exp: nowSeconds + SESSION_SECONDS,
  }));
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    utf8(`${header}.${payload}`),
  ));
  return `${header}.${payload}.${base64Url(signature)}`;
}

export async function throttleSubjectHash(kind: 'email' | 'ip', value: string): Promise<string> {
  return sha256Name(['auth-throttle', kind, value]);
}
