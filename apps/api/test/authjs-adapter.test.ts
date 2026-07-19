import { D1Adapter } from '@auth/d1-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite, migratedDatabase } from './helpers/sqlite-d1';

const databases: ReturnType<typeof migratedDatabase>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('installed Auth.js D1 adapter contract', () => {
  it('performs user, account, session, and verification-token CRUD on migration 0009', async () => {
    const sqlite = migratedDatabase();
    databases.push(sqlite);
    const adapter = D1Adapter(d1FromSqlite(sqlite));

    const created = await adapter.createUser!({
      // Auth.js core 0.41 includes `id` in the adapter input type; the
      // installed D1 adapter deliberately generates and returns its own UUID.
      id: 'adapter-input-id-is-ignored',
      name: 'Adapter User',
      email: 'Adapter.User@Example.COM',
      emailVerified: null,
      image: null,
    });
    expect(created).toMatchObject({
      name: 'Adapter User',
      email: 'adapter.user@example.com',
    });
    expect(sqlite.prepare(`
      SELECT email, email_normalized FROM users WHERE id = ?
    `).get(created.id)).toEqual({
      email: 'adapter.user@example.com',
      email_normalized: 'adapter.user@example.com',
    });
    await expect(adapter.getUserByEmail!('ADAPTER.USER@EXAMPLE.COM'))
      .resolves.toMatchObject({ id: created.id });

    const updated = await adapter.updateUser!({
      id: created.id,
      email: 'Updated.User@Example.COM',
      name: 'Updated User',
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: 'Updated User',
      email: 'updated.user@example.com',
    });
    expect(sqlite.prepare(`
      SELECT email_normalized FROM users WHERE id = ?
    `).get(created.id)).toEqual({ email_normalized: 'updated.user@example.com' });

    await adapter.linkAccount!({
      userId: created.id,
      type: 'oauth',
      provider: 'test-provider',
      providerAccountId: 'provider-user-1',
    });
    await expect(adapter.getUserByAccount!({
      provider: 'test-provider',
      providerAccountId: 'provider-user-1',
    })).resolves.toMatchObject({ id: created.id });

    const expires = new Date(Date.now() + 60_000);
    const session = await adapter.createSession!({
      sessionToken: 'database-session-token',
      userId: created.id,
      expires,
    });
    expect(session).toMatchObject({
      sessionToken: 'database-session-token',
      userId: created.id,
    });
    await expect(adapter.getSessionAndUser!('database-session-token'))
      .resolves.toMatchObject({
        user: { id: created.id },
        session: { sessionToken: 'database-session-token' },
      });

    const verification = await adapter.createVerificationToken!({
      identifier: 'updated.user@example.com',
      token: 'verification-token',
      expires,
    });
    expect(verification).toMatchObject({ token: 'verification-token' });
    await expect(adapter.useVerificationToken!({
      identifier: 'updated.user@example.com',
      token: 'verification-token',
    })).resolves.toMatchObject({ token: 'verification-token' });
    await expect(adapter.useVerificationToken!({
      identifier: 'updated.user@example.com',
      token: 'verification-token',
    })).resolves.toBeNull();

    await adapter.deleteUser!(created.id);
    await expect(adapter.getUser!(created.id)).resolves.toBeNull();
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
