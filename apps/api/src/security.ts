const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(value));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = utf8(left);
  const b = utf8(right);
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

export async function hmacSha256Hex(
  secret: string,
  body: ArrayBuffer | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const source = body instanceof Uint8Array
    ? new Uint8Array(body)
    : new Uint8Array(body);
  const signature = await crypto.subtle.sign('HMAC', key, source);
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyMetaSignature(
  signatureHeader: string | null,
  rawBody: ArrayBuffer | Uint8Array,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const supplied = signatureHeader.slice('sha256='.length).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return constantTimeEqual(supplied, expected);
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return new Uint8Array(Array.from(binary, (character) => character.charCodeAt(0)));
}

export function base64Encode(bytes: ArrayBuffer | Uint8Array): string {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    binary += String.fromCharCode(...input.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function sha256Name(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(parts.join('\u0000')));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
