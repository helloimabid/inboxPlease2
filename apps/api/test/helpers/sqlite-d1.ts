import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@auth/d1-adapter';

const migrationDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function migratedDatabase(version = 11): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (let number = 1; number <= version; number += 1) {
    const prefix = number.toString().padStart(4, '0');
    const name = [
      '0001_initial.sql',
      '0002_money_minor_units.sql',
      '0003_queue_idempotency.sql',
      '0004_payment_attempts.sql',
      '0005_tenant_integrity_and_product_search.sql',
      '0006_order_idempotency.sql',
      '0007_transactional_outbox.sql',
      '0008_auth_accounts.sql',
      '0009_authjs_drizzle.sql',
      '0010_facebook_page_onboarding.sql',
      '0011_catalog_variants_and_media.sql',
    ].find((candidate) => candidate.startsWith(prefix));
    if (!name) throw new Error(`Missing test migration ${prefix}`);
    database.exec(readFileSync(`${migrationDirectory}${name}`, 'utf8'));
  }
  return database;
}

class SqliteD1Statement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
  ) {}

  bind(...values: SQLInputValue[]) {
    this.bindings = values;
    return this;
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.bindings) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T>() {
    const results = this.database.prepare(this.query).all(...this.bindings) as T[];
    return { success: true, results, meta: {} };
  }

  async raw<T extends unknown[]>() {
    const statement = this.database.prepare(this.query);
    statement.setReturnArrays(true);
    return statement.all(...this.bindings) as unknown as T[];
  }

  async run<T>() {
    const result = this.database.prepare(this.query).run(...this.bindings);
    return {
      success: true,
      results: [] as T[],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class SqliteD1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(query: string) {
    this.database.exec(query);
    return { count: 0, duration: 0 };
  }
}

export function d1FromSqlite(database: DatabaseSync): D1Database {
  return new SqliteD1Database(database) as unknown as D1Database;
}
