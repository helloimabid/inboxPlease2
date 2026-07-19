import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { dashboardCors } from '../src/cors';
import type { Bindings } from '../src/env';
import { customerThreadObjectName, storePageObjectName } from '../src/durable/tenant-names';
import {
  constantTimeEqual,
  hmacSha256Hex,
  verifyMetaSignature,
} from '../src/security';
import { validatedMetaMediaUrl } from '../src/integrations/meta';
import { detectImageContentType } from '../src/routes/media';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/secret-envelope';
import { BodyTooLargeError, readBodyBounded } from '../src/bounded-body';

describe('webhook security', () => {
  it('verifies Meta HMAC over the untouched raw bytes', async () => {
    const body = new TextEncoder().encode('{"entry":[]}');
    const signature = await hmacSha256Hex('app-secret', body);
    expect(await verifyMetaSignature(`sha256=${signature}`, body, 'app-secret')).toBe(true);
    expect(await verifyMetaSignature(`sha256=${signature}`, new TextEncoder().encode('{ }'), 'app-secret')).toBe(false);
  });

  it('rejects malformed signatures', async () => {
    const body = new TextEncoder().encode('{}');
    expect(await verifyMetaSignature('sha1=abc', body, 'secret')).toBe(false);
    expect(await verifyMetaSignature('sha256=xyz', body, 'secret')).toBe(false);
  });

  it('compares values without early length exits', () => {
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
  });
});

describe('browser authentication CORS', () => {
  it('allows the Auth.js JSON redirect request from the dashboard', async () => {
    const app = new Hono()
      .use('*', dashboardCors())
      .get('*', (c) => c.body(null, 204));
    const response = await app.request('https://api.inboxplease.test/authjs/signin/facebook', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dashboard.inboxplease.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-auth-return-redirect',
      },
    }, {
      DASHBOARD_ORIGIN: 'https://dashboard.inboxplease.test',
    } as Bindings);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin'))
      .toBe('https://dashboard.inboxplease.test');
    expect(response.headers.get('Access-Control-Allow-Headers'))
      .toContain('X-Auth-Return-Redirect');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});

describe('tenant-safe Durable Object names', () => {
  it('is deterministic and separates merchants, pages, and customers', async () => {
    const first = await customerThreadObjectName('m1', 'p1', 'c1');
    expect(await customerThreadObjectName('m1', 'p1', 'c1')).toBe(first);
    expect(await customerThreadObjectName('m2', 'p1', 'c1')).not.toBe(first);
    expect(await customerThreadObjectName('m1', 'p2', 'c1')).not.toBe(first);
    expect(await customerThreadObjectName('m1', 'p1', 'c2')).not.toBe(first);
    expect(await storePageObjectName('m1', 'p1')).not.toBe(first);
  });
});

describe('Meta media URL boundary', () => {
  it('accepts only trusted HTTPS Meta media hosts', () => {
    expect(validatedMetaMediaUrl('https://scontent.fdac1-1.fna.fbcdn.net/file').hostname)
      .toContain('fbcdn.net');
    expect(() => validatedMetaMediaUrl('http://scontent.fbcdn.net/file')).toThrow();
    expect(() => validatedMetaMediaUrl('https://fbcdn.net.attacker.example/file')).toThrow();
    expect(() => validatedMetaMediaUrl('https://user:secret@facebook.com/file')).toThrow();
  });
});

describe('catalog media signatures', () => {
  it('detects supported image magic bytes and rejects arbitrary bodies', () => {
    expect(detectImageContentType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])))
      .toBe('image/jpeg');
    expect(detectImageContentType(Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]))).toBe('image/png');
    expect(detectImageContentType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif');
    expect(detectImageContentType(new TextEncoder().encode('RIFF0000WEBP'))).toBe('image/webp');
    expect(detectImageContentType(new TextEncoder().encode('<script>'))).toBeNull();
  });
});

describe('managed-key token envelopes', () => {
  it('round-trips AES-GCM secrets and rejects tampering', async () => {
    const key = btoa('k'.repeat(32));
    const encrypted = await encryptSecret('page-access-token', key);
    expect(isEncryptedSecret(encrypted)).toBe(true);
    await expect(decryptSecret(encrypted, key)).resolves.toBe('page-access-token');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptSecret(tampered, key)).rejects.toThrow('authenticated');
  });
});

describe('bounded streaming bodies', () => {
  it('stops buffering as soon as the byte limit is crossed', async () => {
    const withinLimit = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3]));
        controller.close();
      },
    });
    await expect(readBodyBounded(withinLimit, 3)).resolves.toHaveProperty('byteLength', 3);

    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
      },
    });
    await expect(readBodyBounded(tooLarge, 3)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
