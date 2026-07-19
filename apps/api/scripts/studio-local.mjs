import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { AUTHJS_REQUIRED_COLUMNS } from '../../../scripts/authjs-schema-columns.mjs';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));
const localD1Directory = fileURLToPath(
  new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url),
);
const checkOnly = process.argv.includes('--check');
const onboardingColumns = {
  store_pages: [
    'id', 'merchant_id', 'name', 'meta_page_access_token', 'connected_at',
    'created_at', 'updated_at', 'meta_subscription_status',
    'meta_permissions_json', 'meta_tasks_json', 'messaging_ready_at',
    'ai_messaging_enabled', 'ai_messaging_approved_at',
    'ai_messaging_approved_by_user_id', 'ai_messaging_disabled_at',
    'disconnected_at', 'meta_last_error', 'meta_connection_generation',
    'meta_operation_id', 'meta_operation_kind', 'meta_operation_expires_at',
    'meta_subscription_desired', 'meta_reconcile_after',
    'meta_reconcile_attempts', 'meta_reconcile_failures',
  ],
  meta_onboarding_sessions: [
    'id', 'state_digest', 'user_id', 'merchant_id', 'facebook_user_id',
    'status', 'requested_permissions_json', 'granted_permissions_json',
    'expires_at', 'consumed_at', 'error_code', 'created_at', 'updated_at',
  ],
  meta_page_candidates: [
    'session_id', 'page_id', 'name', 'access_token_encrypted', 'tasks_json',
    'created_at',
  ],
};
const catalogColumns = {
  product_variants: [
    'id', 'merchant_id', 'product_id', 'sku', 'name', 'price_minor', 'stock',
    'position', 'created_at', 'updated_at',
  ],
  media_assets: [
    'id', 'merchant_id', 'product_id', 'r2_key', 'content_type', 'byte_size',
    'created_at', 'variant_id', 'role',
  ],
};

function block(message) {
  console.error(`Drizzle Studio blocked: ${message}`);
  process.exit(1);
}

function isInside(directory, target) {
  const pathFromDirectory = relative(directory, target);
  return pathFromDirectory !== '' &&
    !pathFromDirectory.startsWith('..') &&
    !isAbsolute(pathFromDirectory);
}

const wrangler = fileURLToPath(
  new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const migrate = spawnSync(
  process.execPath,
  [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local'],
  { cwd: apiDirectory, stdio: 'inherit' },
);
if (migrate.status !== 0) block('local D1 migrations did not complete successfully.');

const expectedMigrations = (await readdir(new URL('../migrations/', import.meta.url)))
  .filter((name) => /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(name))
  .sort();

function inspectCandidate(databasePath) {
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    const tables = new Set(
      database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all().map((row) => row.name),
    );
    if (!tables.has('d1_migrations')) return false;

    const applied = database.prepare(
      'SELECT name FROM d1_migrations ORDER BY id',
    ).all().map((row) => row.name);
    if (JSON.stringify(applied) !== JSON.stringify(expectedMigrations)) return false;

    for (const [tableName, requiredColumns] of Object.entries(AUTHJS_REQUIRED_COLUMNS)) {
      if (!tables.has(tableName)) return false;
      const actualColumns = new Set(
        database.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name),
      );
      if (requiredColumns.some((column) => !actualColumns.has(column))) return false;
    }

    for (const [tableName, expectedColumns] of Object.entries(onboardingColumns)) {
      if (!tables.has(tableName)) return false;
      const actualColumns = database.prepare(`PRAGMA table_info(${tableName})`)
        .all().map((row) => row.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) return false;
    }
    for (const [tableName, expectedColumns] of Object.entries(catalogColumns)) {
      if (!tables.has(tableName)) return false;
      const actualColumns = database.prepare(`PRAGMA table_info(${tableName})`)
        .all().map((row) => row.name);
      if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) return false;
    }
    const triggers = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    ).all().map((row) => row.name));
    for (const trigger of [
      'store_pages_ai_enable_insert',
      'store_pages_ai_enable_update',
      'store_pages_meta_operation_insert',
      'store_pages_meta_operation_update',
      'users_disable_page_ai_before_delete',
    ]) {
      if (!triggers.has(trigger)) return false;
    }

    return database.pragma('foreign_key_check').length === 0;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

let candidates;
const override = process.env.INBOXPLEASE_LOCAL_D1_PATH;
if (override) {
  const requestedPath = resolve(apiDirectory, override);
  if (!isInside(localD1Directory, requestedPath) || !requestedPath.endsWith('.sqlite')) {
    block('INBOXPLEASE_LOCAL_D1_PATH must name a local Wrangler D1 SQLite file.');
  }
  candidates = [requestedPath];
} else {
  let entries;
  try {
    entries = await readdir(localD1Directory, { withFileTypes: true });
  } catch {
    block('Wrangler did not create local D1 state. Run the local migration command first.');
  }
  candidates = entries
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.sqlite$/i.test(entry.name))
    .map((entry) => resolve(localD1Directory, entry.name));
}

const matchingDatabases = candidates.filter(inspectCandidate);
if (matchingDatabases.length !== 1) {
  block(
    matchingDatabases.length === 0
      ? 'no local D1 file has the exact current migration ledger and application schema.'
      : 'multiple current local D1 files were found; set INBOXPLEASE_LOCAL_D1_PATH explicitly.',
  );
}

const localDatabasePath = matchingDatabases[0];
console.log(
  `Local-only Drizzle Studio target verified: ${relative(apiDirectory, localDatabasePath)}`,
);
console.log('Auth tables: users, accounts, sessions, verification_tokens, merchant_memberships');
console.log('Facebook tables: store_pages, meta_onboarding_sessions, meta_page_candidates');
console.log('Catalog tables: products, product_variants, media_assets');
if (checkOnly) process.exit(0);

const drizzleKit = fileURLToPath(
  new URL('../../../node_modules/drizzle-kit/bin.cjs', import.meta.url),
);
const studio = spawnSync(
  process.execPath,
  [
    drizzleKit,
    'studio',
    '--config', 'drizzle.studio.config.ts',
    '--host=127.0.0.1',
  ],
  {
    cwd: apiDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      INBOXPLEASE_LOCAL_D1_PATH: localDatabasePath,
    },
  },
);
process.exit(studio.status ?? 1);
