import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AUTHJS_REQUIRED_COLUMNS } from '../../../scripts/authjs-schema-columns.mjs';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const configuredDatabase = config.d1_databases?.find((entry) => entry.binding === 'DB');

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return values;
}

let rootEnvironment = {};
try {
  rootEnvironment = parseEnv(
    await readFile(new URL('../../../.env.local', import.meta.url), 'utf8'),
  );
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const targetName = process.env.INBOXPLEASE_D1_NAME ?? rootEnvironment.INBOXPLEASE_D1_NAME;
const approvedValue = process.env.INBOXPLEASE_APPROVED_MIGRATIONS;
const childEnvironment = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID:
    process.env.CLOUDFLARE_ACCOUNT_ID ?? rootEnvironment.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN:
    process.env.CLOUDFLARE_API_TOKEN ?? rootEnvironment.CLOUDFLARE_API_TOKEN,
};

function block(message) {
  console.error(`Remote migration blocked: ${message}`);
  process.exit(1);
}

if (!configuredDatabase?.database_name) block('the DB binding has no configured database_name.');
if (!targetName) block('set INBOXPLEASE_D1_NAME to the explicitly approved database name.');
if (targetName !== configuredDatabase.database_name) {
  block('INBOXPLEASE_D1_NAME does not exactly match the configured DB database_name.');
}
if (!approvedValue) {
  block('set INBOXPLEASE_APPROVED_MIGRATIONS to the exact comma-separated pending migration list.');
}
if (!childEnvironment.CLOUDFLARE_ACCOUNT_ID || !childEnvironment.CLOUDFLARE_API_TOKEN) {
  block('Cloudflare credentials are missing from the process environment or root .env.local.');
}

const wrangler = fileURLToPath(
  new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
function wranglerRead(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: apiDirectory,
    encoding: 'utf8',
    env: childEnvironment,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    block(`Wrangler read-only preflight failed for ${targetName}.`);
  }
  return result.stdout ?? '';
}

const localMigrations = (await readdir(new URL('../migrations/', import.meta.url)))
  .filter((name) => /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(name))
  .sort();
const listOutput = wranglerRead(['d1', 'migrations', 'list', targetName, '--remote']);
const pending = [...new Set(listOutput.match(/\b\d{4}_[A-Za-z0-9_.-]+\.sql\b/g) ?? [])].sort();
const approved = approvedValue === 'none'
  ? []
  : [...new Set(approvedValue.split(',').map((name) => name.trim()).filter(Boolean))].sort();
if (approved.some((name) => !/^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(name))) {
  block('INBOXPLEASE_APPROVED_MIGRATIONS contains an invalid migration name.');
}
if (JSON.stringify(approved) !== JSON.stringify(pending)) {
  block(`approved migrations must exactly equal pending migrations (${pending.join(',') || 'none'}).`);
}
if (pending.some((name) => !localMigrations.includes(name))) {
  block('the remote ledger reports a pending migration not present in this checkout.');
}
const applied = localMigrations.filter((name) => !pending.includes(name));
if (JSON.stringify(applied) !== JSON.stringify(localMigrations.slice(0, applied.length))) {
  block('the remote migration ledger is not a contiguous InboxPlease v2 prefix.');
}

const schemaOutput = wranglerRead([
  'd1', 'execute', targetName, '--remote', '--json', '--command',
  `SELECT m.name AS table_name, p.name AS column_name
   FROM sqlite_master AS m
   JOIN pragma_table_info(m.name) AS p
   WHERE m.type = 'table'
     AND m.name NOT LIKE 'sqlite_%'
     AND m.name NOT LIKE '_cf_%'
   ORDER BY m.name, p.cid`,
]);
let schemaPayload;
try {
  schemaPayload = JSON.parse(schemaOutput.slice(schemaOutput.indexOf('[')));
} catch {
  block('could not parse the remote sqlite_master preflight result.');
}
const schemaRows = schemaPayload.flatMap((result) => result.results ?? []);
const actual = new Map();
for (const row of schemaRows) {
  if (typeof row.table_name !== 'string' || typeof row.column_name !== 'string') continue;
  const columns = actual.get(row.table_name) ?? new Set();
  columns.add(row.column_name);
  actual.set(row.table_name, columns);
}
const hasMigrationLedger = actual.has('d1_migrations');
actual.delete('d1_migrations');
let ledgerNames = [];
if (hasMigrationLedger) {
  const ledgerOutput = wranglerRead([
    'd1', 'execute', targetName, '--remote', '--json', '--command',
    'SELECT name FROM d1_migrations ORDER BY id',
  ]);
  try {
    const ledgerPayload = JSON.parse(ledgerOutput.slice(ledgerOutput.indexOf('[')));
    ledgerNames = ledgerPayload.flatMap((result) => result.results ?? [])
      .map((row) => row.name)
      .filter((name) => typeof name === 'string');
  } catch {
    block('could not parse the remote d1_migrations ledger.');
  }
}
if (JSON.stringify(ledgerNames) !== JSON.stringify(applied)) {
  block('the remote d1_migrations ledger is not the exact contiguous InboxPlease v2 prefix.');
}

const stage = applied.length;
const expected = new Map();
const table = (name, columns) => expected.set(name, new Set(columns));
if (stage >= 1) {
  table('merchants', ['id', 'name', 'plan', 'status', 'created_at', 'updated_at']);
  table('store_pages', [
    'id', 'merchant_id', 'name', 'meta_page_access_token', 'connected_at',
    'created_at', 'updated_at',
    ...(stage >= 10 ? [
      'meta_subscription_status', 'meta_permissions_json', 'meta_tasks_json',
      'messaging_ready_at', 'ai_messaging_enabled',
      'ai_messaging_approved_at', 'ai_messaging_approved_by_user_id',
      'ai_messaging_disabled_at', 'disconnected_at', 'meta_last_error',
      'meta_connection_generation', 'meta_operation_id', 'meta_operation_kind',
      'meta_operation_expires_at', 'meta_subscription_desired',
      'meta_reconcile_after', 'meta_reconcile_attempts', 'meta_reconcile_failures',
    ] : []),
  ]);
  table('merchant_settings', ['merchant_id', 'assistant_name', 'store_description', 'default_language', 'tone', 'currency', 'business_hours_json', stage >= 2 ? 'escalation_cart_threshold_minor' : 'escalation_cart_threshold_cents', 'updated_at']);
  table('products', ['id', 'merchant_id', 'page_id', 'sku', 'name', 'description', stage >= 2 ? 'price_minor' : 'price_cents', 'currency', 'stock', 'status', 'created_at', 'updated_at']);
  table('media_assets', [
    'id', 'merchant_id', 'product_id', 'r2_key', 'content_type', 'byte_size',
    'created_at', ...(stage >= 11 ? ['variant_id', 'role'] : []),
  ]);
  table('orders', ['id', 'merchant_id', 'page_id', 'customer_psid', 'status', 'payment_status', 'payment_transaction_id', stage >= 2 ? 'total_minor' : 'total_cents', 'currency', 'shipping_address_json', 'created_at', 'updated_at', ...(stage >= 6 ? ['idempotency_key'] : []), ...(stage >= 7 ? ['request_fingerprint'] : [])]);
  table('order_items', ['order_id', 'product_id', 'name_snapshot', stage >= 2 ? 'unit_price_minor' : 'unit_price_cents', 'quantity']);
  table('webhook_events', ['provider', 'event_id', 'status', 'attempts', 'received_at', 'processed_at', 'last_error']);
  table('monthly_usage', ['merchant_id', 'month', 'ai_messages', 'vision_messages']);
}
if (stage >= 3) table('queue_jobs', ['event_id', 'job_type', 'status', 'attempts', 'last_error', 'created_at', 'updated_at']);
if (stage >= 4) table('payment_attempts', ['transaction_id', 'order_id', 'merchant_id', 'amount_minor', 'currency', 'status', 'gateway_session_key', 'gateway_page_url', 'last_error', 'created_at', 'updated_at']);
if (stage >= 7) table('outbox_events', ['id', 'event_type', 'payload_json', 'status', 'attempts', 'available_at', 'lease_token', 'lease_expires_at', 'last_error', 'created_at', 'updated_at', 'dispatched_at']);
if (stage >= 8) {
  table('users', stage >= 9 ? AUTHJS_REQUIRED_COLUMNS.users : [
    'id', 'name', 'email_normalized', 'password_hash', 'password_salt',
    'password_iterations', 'status', 'created_at', 'updated_at',
  ]);
  table('merchant_memberships', ['user_id', 'merchant_id', 'role', 'status', 'created_at', 'updated_at']);
  table('auth_login_attempts', ['subject_hash', 'failures', 'window_started_at', 'locked_until', 'updated_at']);
}
if (stage >= 9) {
  table('accounts', AUTHJS_REQUIRED_COLUMNS.accounts);
  table('sessions', AUTHJS_REQUIRED_COLUMNS.sessions);
  table('verification_tokens', AUTHJS_REQUIRED_COLUMNS.verification_tokens);
}
if (stage >= 10) {
  table('meta_onboarding_sessions', [
    'id', 'state_digest', 'user_id', 'merchant_id', 'facebook_user_id', 'status',
    'requested_permissions_json', 'granted_permissions_json', 'expires_at',
    'consumed_at', 'error_code', 'created_at', 'updated_at',
  ]);
  table('meta_page_candidates', [
    'session_id', 'page_id', 'name', 'access_token_encrypted', 'tasks_json',
    'created_at',
  ]);
}
if (stage >= 11) {
  table('product_variants', [
    'id', 'merchant_id', 'product_id', 'sku', 'name', 'price_minor', 'stock',
    'position', 'created_at', 'updated_at',
  ]);
}

for (const [name, columns] of actual) {
  if (stage >= 5 && name.startsWith('products_fts')) continue;
  if (!expected.has(name)) block(`remote table ${name} is not part of the approved v2 schema prefix.`);
  for (const column of expected.get(name)) {
    if (!columns.has(column)) block(`remote table ${name} is missing v2 column ${column}.`);
  }
}
for (const name of expected.keys()) {
  if (!actual.has(name)) block(`remote v2 prefix is missing expected table ${name}.`);
}
if (stage >= 5 && !actual.has('products_fts')) {
  block('remote v2 prefix is missing expected FTS table products_fts.');
}
if (stage > 0) {
  const foreignKeyOutput = wranglerRead([
    'd1', 'execute', targetName, '--remote', '--json', '--command',
    'PRAGMA foreign_key_check',
  ]);
  try {
    const foreignKeyPayload = JSON.parse(
      foreignKeyOutput.slice(foreignKeyOutput.indexOf('[')),
    );
    const violations = foreignKeyPayload.flatMap((result) => result.results ?? []);
    if (violations.length > 0) block('remote v2 prefix has foreign-key violations.');
  } catch {
    block('could not parse the remote foreign-key preflight result.');
  }
}
if (stage >= 10) {
  const triggerOutput = wranglerRead([
    'd1', 'execute', targetName, '--remote', '--json', '--command',
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ]);
  try {
    const triggerPayload = JSON.parse(triggerOutput.slice(triggerOutput.indexOf('[')));
    const triggers = new Set(triggerPayload.flatMap((result) => result.results ?? [])
      .map((row) => row.name)
      .filter((name) => typeof name === 'string'));
    const requiredTriggers = [
      'store_pages_ai_enable_insert',
      'store_pages_ai_enable_update',
      'store_pages_meta_operation_insert',
      'store_pages_meta_operation_update',
      'users_disable_page_ai_before_delete',
    ];
    for (const trigger of requiredTriggers) {
      if (!triggers.has(trigger)) block(`remote v2 schema is missing trigger ${trigger}.`);
    }
  } catch {
    block('could not parse the remote trigger preflight result.');
  }
}

function runStrictD1Audit() {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../../scripts/cloudflare-resources.mjs', import.meta.url)),
      'audit-d1',
    ],
    { cwd: apiDirectory, stdio: 'inherit', env: childEnvironment },
  );
}

if (pending.length === 0) {
  console.log(`Remote preflight passed for ${targetName}; no migrations are pending.`);
  const audit = runStrictD1Audit();
  process.exit(audit.status ?? 1);
}
console.log(`Remote preflight passed for ${targetName}; applying approved migrations: ${pending.join(', ')}`);
const apply = spawnSync(
  process.execPath,
  [wrangler, 'd1', 'migrations', 'apply', targetName, '--remote'],
  { cwd: apiDirectory, stdio: 'inherit', env: childEnvironment },
);
if ((apply.status ?? 1) !== 0) process.exit(apply.status ?? 1);

console.log('Remote migration apply completed; running the exact post-apply preflight.');
const verify = spawnSync(
  process.execPath,
  [fileURLToPath(import.meta.url)],
  {
    cwd: apiDirectory,
    stdio: 'inherit',
    env: {
      ...childEnvironment,
      INBOXPLEASE_D1_NAME: targetName,
      INBOXPLEASE_APPROVED_MIGRATIONS: 'none',
    },
  },
);
if ((verify.status ?? 1) !== 0) process.exit(verify.status ?? 1);

const strictSchemaAudit = runStrictD1Audit();
process.exit(strictSchemaAudit.status ?? 1);
