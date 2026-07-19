import { base64Encode, base64UrlDecode, utf8 } from './security';

const PREFIX = 'enc.v1';

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  return base64Encode(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function keyBytes(encodedKey: string): Uint8Array<ArrayBuffer> {
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = base64UrlDecode(encodedKey);
  } catch {
    throw new Error('Token encryption key is not valid base64');
  }
  if (decoded.byteLength !== 32) {
    throw new Error('Token encryption key must decode to exactly 32 bytes');
  }
  return decoded;
}

async function aesKey(
  encodedKey: string,
  usages: Array<'encrypt' | 'decrypt'>,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyBytes(encodedKey),
    { name: 'AES-GCM' },
    false,
    usages,
  );
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${PREFIX}.`);
}

export async function encryptSecret(plaintext: string, encodedKey: string): Promise<string> {
  if (!plaintext) throw new Error('Secret cannot be empty');
  const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(encodedKey, ['encrypt']),
    utf8(plaintext),
  );
  return `${PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

export async function decryptSecret(envelope: string, encodedKey: string): Promise<string> {
  const [prefix, version, encodedIv, encodedCiphertext, ...extra] = envelope.split('.');
  if (`${prefix}.${version}` !== PREFIX || !encodedIv || !encodedCiphertext || extra.length) {
    throw new Error('Encrypted secret envelope is malformed');
  }
  const iv = base64UrlDecode(encodedIv);
  if (iv.byteLength !== 12) throw new Error('Encrypted secret IV is malformed');
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      await aesKey(encodedKey, ['decrypt']),
      base64UrlDecode(encodedCiphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Encrypted secret could not be authenticated');
  }
}
