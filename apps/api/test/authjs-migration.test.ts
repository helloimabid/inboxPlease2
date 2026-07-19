import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHJS_REQUIRED_COLUMNS } from '../../../scripts/authjs-schema-columns.mjs';

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const openDatabases: DatabaseSync[] = [];

function migration(name: string): string {
  return readFileSync(`${migrationDirectory}${name}`, 'utf8');
}

function databaseAtVersion8(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  openDatabases.push(database);
  for (const name of [
    '0001_initial.sql',
    '0002_money_minor_units.sql',
    '0003_queue_idempotency.sql',
    '0004_payment_attempts.sql',
    '0005_tenant_integrity_and_product_search.sql',
    '0006_order_idempotency.sql',
    '0007_transactional_outbox.sql',
    '0008_auth_accounts.sql',
  ]) {
    database.exec(migration(name));
  }
  return database;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('0009 Auth.js migration', () => {
  it('preserves version-8 password users and memberships with valid foreign keys', () => {
    const database = databaseAtVersion8();
    database.exec(`
      INSERT INTO merchants (id, name) VALUES ('merchant-1', 'Existing shop');
      INSERT INTO users (
        id, name, email_normalized, password_hash, password_salt, password_iterations
      ) VALUES (
        'user-1', 'Existing Owner', 'owner@example.com', 'hash', 'salt', 600000
      );
      INSERT INTO merchant_memberships (user_id, merchant_id, role)
      VALUES ('user-1', 'merchant-1', 'owner');
    `);

    database.exec(migration('0009_authjs_drizzle.sql'));

    expect(database.prepare(`
      SELECT id, name, email, email_normalized, password_hash, password_salt,
             password_iterations, status
      FROM users WHERE id = 'user-1'
    `).get()).toMatchObject({
      id: 'user-1',
      name: 'Existing Owner',
      email: 'owner@example.com',
      email_normalized: 'owner@example.com',
      password_hash: 'hash',
      password_salt: 'salt',
      password_iterations: 600_000,
      status: 'active',
    });
    expect(database.prepare(`
      SELECT user_id, merchant_id, role, status FROM merchant_memberships
    `).get()).toEqual({
      user_id: 'user-1', merchant_id: 'merchant-1', role: 'owner', status: 'active',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('supports adapter-shaped users and keeps adapter emails normalized', () => {
    const database = databaseAtVersion8();
    database.exec(migration('0009_authjs_drizzle.sql'));

    database.prepare(`
      INSERT INTO users (id, name, email, emailVerified, image)
      VALUES (?, ?, ?, ?, ?)
    `).run('auth-user', 'Auth User', '  Auth.User@Example.COM  ', null, null);
    expect(database.prepare(`
      SELECT email, email_normalized, password_hash FROM users WHERE id = ?
    `).get('auth-user')).toEqual({
      email: 'auth.user@example.com',
      email_normalized: 'auth.user@example.com',
      password_hash: null,
    });

    database.prepare('UPDATE users SET email = ? WHERE id = ?')
      .run('NEW.Address@Example.COM', 'auth-user');
    expect(database.prepare(`
      SELECT email, email_normalized FROM users WHERE id = ?
    `).get('auth-user')).toEqual({
      email: 'new.address@example.com',
      email_normalized: 'new.address@example.com',
    });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('matches the complete stage-9 Auth.js audit column contract', () => {
    const database = databaseAtVersion8();
    database.exec(migration('0009_authjs_drizzle.sql'));
    for (const [table, requiredColumns] of Object.entries(AUTHJS_REQUIRED_COLUMNS)) {
      const actual = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      expect(
        requiredColumns.filter((column) => !actual.has(column)),
        `${table} is missing Auth.js adapter columns`,
      ).toEqual([]);
    }
  });
});
