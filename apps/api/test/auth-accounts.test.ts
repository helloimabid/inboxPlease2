import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  normalizeEmail,
  signSessionToken,
  throttleSubjectHash,
  verifyPassword,
} from '../src/auth-accounts';
import { verifySessionToken } from '../src/auth';
import type { Bindings } from '../src/env';

describe('first-party account security', () => {
  it('normalizes email addresses before uniqueness and lookup', () => {
    expect(normalizeEmail('  Seller@Example.COM  ')).toBe('seller@example.com');
    expect(normalizeEmail('Ｔｅｓｔ@example.com')).toBe('test@example.com');
  });

  it('hashes passwords with random salts and verifies in constant-work paths', async () => {
    const first = await hashPassword('a strong password');
    const second = await hashPassword('a strong password');
    expect(first.iterations).toBeGreaterThanOrEqual(600_000);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    await expect(verifyPassword('a strong password', first)).resolves.toBe(true);
    await expect(verifyPassword('a wrong password', first)).resolves.toBe(false);
  });

  it('mints tokens accepted by the existing session verifier', async () => {
    const env = {
      AUTH_SECRET: 'this-secret-is-at-least-thirty-two-bytes-long',
      AUTH_ISSUER: 'inboxplease',
      AUTH_AUDIENCE: 'dashboard',
    } as Bindings;
    const token = await signSessionToken(env, {
      userId: 'user-1',
      merchantId: 'merchant-1',
      role: 'owner',
    }, 1_000);
    await expect(verifySessionToken(token, env, 1_001)).resolves.toMatchObject({
      subject: 'user-1',
      merchantId: 'merchant-1',
      role: 'owner',
      source: 'session',
    });
  });

  it('does not retain raw email or IP values in throttle keys', async () => {
    const email = await throttleSubjectHash('email', 'seller@example.com');
    const ip = await throttleSubjectHash('ip', '203.0.113.7');
    expect(email).toMatch(/^[a-f0-9]{64}$/);
    expect(ip).toMatch(/^[a-f0-9]{64}$/);
    expect(email).not.toBe(ip);
    expect(email).not.toContain('seller');
  });
});
