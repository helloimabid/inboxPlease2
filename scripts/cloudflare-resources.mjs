import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AUTHJS_REQUIRED_COLUMNS } from './authjs-schema-columns.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const command = process.argv[2] ?? 'audit';
if (!['audit', 'audit-d1', 'sync-d1', 'provision'].includes(command)) {
  throw new Error(
    'Usage: node scripts/cloudflare-resources.mjs [audit|audit-d1|sync-d1|provision]',
  );
}

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

let credentialFile = {};
try {
  credentialFile = parseEnv(await readFile(resolve(repositoryRoot, '.env.local'), 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const credentials = {
  ...credentialFile,
  CLOUDFLARE_ACCOUNT_ID:
    process.env.CLOUDFLARE_ACCOUNT_ID ?? credentialFile.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN:
    process.env.CLOUDFLARE_API_TOKEN ?? credentialFile.CLOUDFLARE_API_TOKEN,
};
if (!credentials.CLOUDFLARE_ACCOUNT_ID || !credentials.CLOUDFLARE_API_TOKEN) {
  throw new Error('Run scripts/normalize-cloudflare-credentials.mjs first');
}

const wrangler = resolve(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const childEnv = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: credentials.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN,
};

function run(args) {
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : wrangler;
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', wrangler, ...args]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: childEnv,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function category(output) {
  if (/permission|unauthorized|forbidden|authentication|code.?10000/iu.test(output)) return 'permission';
  if (/not enabled|plan|subscription|paid/iu.test(output)) return 'plan';
  if (/timed out|ENOTFOUND|network|fetch failed|ECONN/iu.test(output)) return 'network';
  if (/already exists|duplicate/iu.test(output)) return 'already-exists';
  return 'other';
}

function requireSuccess(result, operation) {
  if (!result.ok) throw new Error(`${operation} failed (${category(result.output)})`);
  return result;
}

function includesName(result, name) {
  requireSuccess(result, `list ${name}`);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, 'mu')
    .test(result.output);
}

function parseJsonOutput(result, operation) {
  requireSuccess(result, operation);
  const trimmed = result.output.trim();
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((index) => index >= 0);
  if (!starts.length) throw new Error(`${operation} returned no JSON`);
  const start = Math.min(...starts);
  const candidate = trimmed.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`${operation} returned malformed JSON`);
  }
}

function nestedRecords(value) {
  if (Array.isArray(value)) return value.flatMap(nestedRecords);
  if (!value || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(nestedRecords)];
}

function d1Databases() {
  const data = parseJsonOutput(run(['d1', 'list', '--json']), 'list D1 databases');
  return Array.isArray(data) ? data : data.result ?? [];
}

function validateResourceName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, hyphens, or underscores`);
  }
  return value;
}

function d1Rows(databaseName, sql, operation) {
  validateResourceName(databaseName, 'D1 database name');
  const data = parseJsonOutput(run([
    'd1', 'execute', databaseName, '--remote', '--command', sql, '--json',
  ]), operation);
  const batches = Array.isArray(data) ? data : (Array.isArray(data.result) ? data.result : [data]);
  return batches.flatMap((batch) => {
    if (Array.isArray(batch?.results)) return batch.results;
    if (Array.isArray(batch?.result?.results)) return batch.result.results;
    return [];
  });
}

async function expectedMigrationNames() {
  return (await readdir(resolve(repositoryRoot, 'apps/api/migrations')))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort();
}

async function d1SchemaStatus(databaseName) {
  const tableRows = d1Rows(
    databaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    `inspect D1 schema for ${databaseName}`,
  );
  const tables = new Set(tableRows.map((row) => row.name).filter((name) => typeof name === 'string'));
  const applicationTables = [...tables].filter((name) => (
    name !== 'd1_migrations' && !name.startsWith('_cf_')
  ));
  if (applicationTables.length === 0) return 'empty-unmigrated';
  if (tables.has('sellers') || (tables.has('products') && !tables.has('merchants'))) {
    return 'legacy-incompatible';
  }

  const requiredTables = [
    'merchants', 'store_pages', 'merchant_settings', 'products', 'media_assets',
    'orders', 'order_items', 'webhook_events', 'monthly_usage', 'queue_jobs',
    'payment_attempts', 'outbox_events', 'users', 'merchant_memberships',
    'auth_login_attempts', 'accounts', 'sessions', 'verification_tokens',
    'meta_onboarding_sessions', 'meta_page_candidates', 'product_variants',
    'products_fts',
  ];
  if (!requiredTables.every((name) => tables.has(name)) || !tables.has('d1_migrations')) {
    return 'v2-partial';
  }

  const expected = await expectedMigrationNames();
  const applied = d1Rows(
    databaseName,
    'SELECT name FROM d1_migrations ORDER BY id',
    `inspect D1 migration ledger for ${databaseName}`,
  ).map((row) => row.name).filter((name) => typeof name === 'string');
  if (expected.length !== applied.length || expected.some((name, index) => applied[index] !== name)) {
    return 'v2-partial';
  }

  const requiredColumns = {
    ...AUTHJS_REQUIRED_COLUMNS,
    merchants: ['id', 'name', 'plan', 'status', 'created_at', 'updated_at'],
    store_pages: [
      'id', 'merchant_id', 'name', 'meta_page_access_token', 'connected_at',
      'created_at', 'updated_at',
      'meta_subscription_status', 'meta_permissions_json', 'meta_tasks_json',
      'messaging_ready_at', 'ai_messaging_enabled',
      'ai_messaging_approved_at', 'ai_messaging_approved_by_user_id',
      'ai_messaging_disabled_at', 'disconnected_at', 'meta_last_error',
      'meta_connection_generation', 'meta_operation_id', 'meta_operation_kind',
      'meta_operation_expires_at', 'meta_subscription_desired',
      'meta_reconcile_after', 'meta_reconcile_attempts', 'meta_reconcile_failures',
    ],
    meta_onboarding_sessions: [
      'id', 'state_digest', 'user_id', 'merchant_id', 'facebook_user_id',
      'status', 'requested_permissions_json', 'granted_permissions_json',
      'expires_at', 'consumed_at', 'error_code', 'created_at', 'updated_at',
    ],
    meta_page_candidates: [
      'session_id', 'page_id', 'name', 'access_token_encrypted',
      'tasks_json', 'created_at',
    ],
    merchant_settings: [
      'merchant_id', 'assistant_name', 'store_description', 'default_language',
      'tone', 'currency', 'business_hours_json',
      'escalation_cart_threshold_minor', 'updated_at',
    ],
    products: [
      'id', 'merchant_id', 'page_id', 'sku', 'name', 'description',
      'price_minor', 'currency', 'stock', 'status', 'created_at', 'updated_at',
    ],
    media_assets: [
      'id', 'merchant_id', 'product_id', 'r2_key', 'content_type', 'byte_size',
      'created_at', 'variant_id', 'role',
    ],
    product_variants: [
      'id', 'merchant_id', 'product_id', 'sku', 'name', 'price_minor', 'stock',
      'position', 'created_at', 'updated_at',
    ],
    orders: [
      'id', 'merchant_id', 'page_id', 'customer_psid', 'status', 'payment_status',
      'payment_transaction_id', 'total_minor', 'currency', 'shipping_address_json',
      'created_at', 'updated_at', 'idempotency_key', 'request_fingerprint',
    ],
    order_items: ['order_id', 'product_id', 'name_snapshot', 'unit_price_minor', 'quantity'],
    webhook_events: [
      'provider', 'event_id', 'status', 'attempts', 'received_at', 'processed_at',
      'last_error',
    ],
    monthly_usage: ['merchant_id', 'month', 'ai_messages', 'vision_messages'],
    queue_jobs: [
      'event_id', 'job_type', 'status', 'attempts', 'last_error', 'created_at',
      'updated_at',
    ],
    payment_attempts: [
      'transaction_id', 'order_id', 'merchant_id', 'amount_minor', 'currency',
      'status', 'gateway_session_key', 'gateway_page_url', 'last_error',
      'created_at', 'updated_at',
    ],
    outbox_events: [
      'id', 'event_type', 'payload_json', 'status', 'attempts', 'available_at',
      'lease_token', 'lease_expires_at', 'last_error', 'created_at', 'updated_at',
      'dispatched_at',
    ],
    merchant_memberships: [
      'user_id', 'merchant_id', 'role', 'status', 'created_at', 'updated_at',
    ],
    auth_login_attempts: [
      'subject_hash', 'failures', 'window_started_at', 'locked_until', 'updated_at',
    ],
    products_fts: ['product_id', 'merchant_id', 'page_id', 'name', 'sku', 'description'],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(d1Rows(
      databaseName,
      `PRAGMA table_info(${table})`,
      `inspect ${table} columns for ${databaseName}`,
    ).map((row) => row.name).filter((name) => typeof name === 'string'));
    if (!columns.every((name) => actual.has(name))) return 'v2-partial';
  }

  const requiredTriggers = [
    'media_tenant_product_insert',
    'media_tenant_product_update',
    'media_variant_consistency_insert',
    'media_variant_consistency_update',
    'order_items_catalog_snapshot_insert',
    'order_items_tenant_insert',
    'orders_cancelled_restock',
    'orders_tenant_page_insert',
    'orders_tenant_page_update',
    'payment_attempts_reservation_insert',
    'payment_attempts_tenant_insert',
    'products_fts_delete',
    'products_fts_insert',
    'products_fts_update',
    'products_plan_limit_insert',
    'products_plan_limit_reactivate',
    'products_tenant_page_insert',
    'products_tenant_page_update',
    'product_variants_tenant_product_insert',
    'product_variants_tenant_product_update',
    'store_pages_ai_enable_insert',
    'store_pages_ai_enable_update',
    'store_pages_meta_operation_insert',
    'store_pages_meta_operation_update',
    'users_disable_page_ai_before_delete',
    'users_normalize_adapter_email_insert',
    'users_normalize_adapter_email_update',
  ];
  const triggerRows = d1Rows(
    databaseName,
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    `inspect D1 triggers for ${databaseName}`,
  );
  const triggers = new Map(triggerRows.flatMap((row) => (
    typeof row.name === 'string' && typeof row.sql === 'string'
      ? [[row.name, row.sql]]
      : []
  )));
  if (!requiredTriggers.every((name) => triggers.has(name))) return 'v2-partial';
  if (
    !triggers.get('store_pages_ai_enable_insert')
      ?.includes('AI messaging approval is incomplete') ||
    !triggers.get('store_pages_ai_enable_update')
      ?.includes('AI messaging approval is incomplete') ||
    !triggers.get('store_pages_meta_operation_insert')
      ?.includes('Meta Page operation lease is incomplete') ||
    !triggers.get('store_pages_meta_operation_update')
      ?.includes('Meta Page operation lease is incomplete') ||
    !triggers.get('users_disable_page_ai_before_delete')
      ?.includes('ai_messaging_enabled = 0')
  ) return 'v2-partial';

  const requiredIndexes = [
    'idx_auth_login_attempts_expiry', 'idx_authjs_accounts_user',
    'idx_authjs_sessions_user', 'idx_authjs_verification_identifier',
    'idx_media_tenant_product', 'idx_memberships_merchant_role',
    'idx_meta_onboarding_expiry', 'idx_meta_onboarding_merchant_user',
    'idx_meta_page_candidates_page', 'idx_orders_tenant_customer',
    'idx_orders_tenant_idempotency', 'idx_orders_tenant_status',
    'idx_outbox_dispatchable', 'idx_payment_attempts_order',
    'idx_product_variants_tenant_product', 'idx_products_tenant_name',
    'idx_products_tenant_page', 'idx_media_tenant_variant',
    'idx_media_product_primary', 'idx_media_variant_primary',
    'idx_queue_jobs_status_updated', 'idx_store_pages_merchant',
    'idx_store_pages_messaging_state', 'idx_store_pages_meta_reconcile',
  ];
  const indexRows = d1Rows(
    databaseName,
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
    `inspect D1 indexes for ${databaseName}`,
  );
  const indexes = new Map(indexRows.flatMap((row) => (
    typeof row.name === 'string' ? [[row.name, row.sql]] : []
  )));
  if (!requiredIndexes.every((name) => indexes.has(name))) return 'v2-partial';
  if (!String(indexes.get('idx_orders_tenant_idempotency')).includes('UNIQUE INDEX')) {
    return 'v2-partial';
  }

  const storePageDefinition = d1Rows(
    databaseName,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'store_pages'",
    `inspect store_pages constraints for ${databaseName}`,
  )[0]?.sql;
  if (
    typeof storePageDefinition !== 'string' ||
    !storePageDefinition.includes("'connecting'") ||
    !storePageDefinition.includes('meta_subscription_desired IN (0, 1)') ||
    !storePageDefinition.includes("meta_operation_kind IN ('connect', 'disconnect')")
  ) return 'v2-partial';

  const foreignKeyTables = [
    'accounts', 'sessions', 'merchant_memberships', 'store_pages',
    'merchant_settings', 'media_assets', 'monthly_usage', 'order_items',
    'payment_attempts', 'meta_onboarding_sessions', 'meta_page_candidates',
    'product_variants',
    'products', 'orders',
  ];
  // D1 currently applies a very small compound-SELECT cap to remote queries,
  // so query each table in the static allowlist independently.
  const foreignKeyRows = [];
  for (const table of foreignKeyTables) {
    const foreignKeySql =
      `SELECT '${table}' AS source_table, [from] AS source_column, ` +
      `[table] AS target_table, [to] AS target_column, on_delete ` +
      `FROM pragma_foreign_key_list('${table}')`;
    foreignKeyRows.push(...d1Rows(
      databaseName,
      foreignKeySql,
      `inspect D1 foreign-key definitions for ${databaseName}`,
    ));
  }
  const actualForeignKeys = new Set(foreignKeyRows.map((row) => (
    `${row.source_table}:${row.source_column}:${row.target_table}:` +
    `${row.target_column}:${String(row.on_delete).toUpperCase()}`
  )));
  const requiredForeignKeys = [
    'accounts:userId:users:id:CASCADE',
    'sessions:userId:users:id:CASCADE',
    'merchant_memberships:user_id:users:id:CASCADE',
    'merchant_memberships:merchant_id:merchants:id:CASCADE',
    'store_pages:merchant_id:merchants:id:CASCADE',
    'store_pages:ai_messaging_approved_by_user_id:users:id:SET NULL',
    'merchant_settings:merchant_id:merchants:id:CASCADE',
    'media_assets:merchant_id:merchants:id:CASCADE',
    'media_assets:product_id:products:id:CASCADE',
    'media_assets:variant_id:product_variants:id:CASCADE',
    'product_variants:merchant_id:merchants:id:CASCADE',
    'product_variants:product_id:products:id:CASCADE',
    'monthly_usage:merchant_id:merchants:id:CASCADE',
    'order_items:order_id:orders:id:CASCADE',
    'order_items:product_id:products:id:RESTRICT',
    'payment_attempts:order_id:orders:id:CASCADE',
    'payment_attempts:merchant_id:merchants:id:CASCADE',
    'meta_onboarding_sessions:user_id:users:id:CASCADE',
    'meta_onboarding_sessions:merchant_id:merchants:id:CASCADE',
    'meta_page_candidates:session_id:meta_onboarding_sessions:id:CASCADE',
    'products:merchant_id:merchants:id:CASCADE',
    'products:page_id:store_pages:id:CASCADE',
    'orders:merchant_id:merchants:id:CASCADE',
    'orders:page_id:store_pages:id:RESTRICT',
  ];
  if (!requiredForeignKeys.every((key) => actualForeignKeys.has(key))) {
    return 'v2-partial';
  }

  const foreignKeyFailures = d1Rows(
    databaseName,
    'PRAGMA foreign_key_check',
    `check D1 foreign keys for ${databaseName}`,
  );
  return foreignKeyFailures.length === 0 ? 'v2-ready' : 'v2-invalid-foreign-keys';
}

async function syncD1Config() {
  const requestedName = process.env.INBOXPLEASE_D1_NAME ?? credentials.INBOXPLEASE_D1_NAME;
  if (!requestedName) {
    throw new Error('Set INBOXPLEASE_D1_NAME to the separately approved v2 D1 database name');
  }
  const databaseName = validateResourceName(requestedName, 'INBOXPLEASE_D1_NAME');
  const database = d1Databases().find((item) => item.name === databaseName);
  const databaseId = database?.uuid ?? database?.id;
  if (!databaseId) throw new Error(`D1 database ${databaseName} was not found`);
  const schema = await d1SchemaStatus(databaseName);
  if (schema !== 'empty-unmigrated' && schema !== 'v2-ready') {
    throw new Error(`D1 database ${databaseName} cannot be bound safely (schema=${schema})`);
  }
  const configPath = resolve(repositoryRoot, 'apps/api/wrangler.jsonc');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const binding = config.d1_databases?.find((item) => item.binding === 'DB');
  if (!binding) throw new Error('D1 binding DB is missing from Wrangler configuration');
  binding.database_name = databaseName;
  binding.database_id = databaseId;
  if (schema === 'empty-unmigrated') {
    config.vars ??= {};
    config.vars.D1_SCHEMA_READY = 'false';
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`kind=d1; resource=${databaseName}; schema=${schema}; config_id=updated-redacted`);
}

async function audit({ strict = false } = {}) {
  const config = JSON.parse(await readFile(
    resolve(repositoryRoot, 'apps/api/wrangler.jsonc'),
    'utf8',
  ));
  const databaseBinding = config.d1_databases?.find((item) => item.binding === 'DB');
  const boundDatabaseName = databaseBinding?.database_name;
  const remoteDatabase = typeof boundDatabaseName === 'string'
    ? d1Databases().find((item) => item.name === boundDatabaseName)
    : undefined;
  const remoteDatabaseId = remoteDatabase?.uuid ?? remoteDatabase?.id;
  const databasePresent = Boolean(
    remoteDatabaseId && remoteDatabaseId === databaseBinding?.database_id,
  );
  const databaseSchema = databasePresent
    ? await d1SchemaStatus(boundDatabaseName)
    : 'missing';
  const vectorList = run(['vectorize', 'list', '--json']);
  const vectorPresent = includesName(vectorList, 'inboxplease-catalog');
  let vectorReady = false;
  if (vectorPresent) {
    const index = parseJsonOutput(
      run(['vectorize', 'get', 'inboxplease-catalog', '--json']),
      'read Vectorize configuration',
    );
    const vectorConfig = nestedRecords(index).find((item) => (
      typeof item.dimensions === 'number' && typeof item.metric === 'string'
    ));
    const metadata = parseJsonOutput(
      run(['vectorize', 'list-metadata-index', 'inboxplease-catalog', '--json']),
      'read Vectorize metadata indexes',
    );
    const pageIdIndex = nestedRecords(metadata).some((item) => (
      (item.propertyName === 'page_id' || item.property_name === 'page_id' || item.name === 'page_id') &&
      String(item.type ?? item.indexType ?? item.kind ?? '').toLowerCase() === 'string'
    ));
    vectorReady = vectorConfig?.dimensions === 1024 && vectorConfig?.metric === 'cosine' && pageIdIndex;
  }
  const pages = parseJsonOutput(
    run(['pages', 'project', 'list', '--json']),
    'list Pages projects',
  );
  const pagesReady = nestedRecords(pages).some((item) => (
    item.name === 'inboxplease-dashboard' || item['Project Name'] === 'inboxplease-dashboard'
  ));
  const checks = [
    ['d1', boundDatabaseName ?? 'DB-unconfigured', databasePresent],
    ['r2', 'inboxplease-media', includesName(run(['r2', 'bucket', 'list']), 'inboxplease-media')],
    ['queue', 'inboxplease-jobs', includesName(run(['queues', 'list']), 'inboxplease-jobs')],
    ['queue', 'inboxplease-jobs-dead-letter', includesName(run(['queues', 'list']), 'inboxplease-jobs-dead-letter')],
    ['vectorize', 'inboxplease-catalog', vectorReady],
    ['pages', 'inboxplease-dashboard', pagesReady],
  ];
  for (const [kind, resource, present] of checks) {
    const schema = kind === 'd1' ? `; schema=${databaseSchema}` : '';
    console.log(`kind=${kind}; resource=${resource}; present=${present}${schema}`);
  }
  if (
    strict &&
    (databaseSchema !== 'v2-ready' || checks.some(([, , present]) => !present))
  ) {
    process.exitCode = 1;
  }
  return checks;
}

async function auditD1() {
  const config = JSON.parse(await readFile(
    resolve(repositoryRoot, 'apps/api/wrangler.jsonc'),
    'utf8',
  ));
  const binding = config.d1_databases?.find((item) => item.binding === 'DB');
  const databaseName = binding?.database_name;
  const remoteDatabase = typeof databaseName === 'string'
    ? d1Databases().find((item) => item.name === databaseName)
    : undefined;
  const remoteDatabaseId = remoteDatabase?.uuid ?? remoteDatabase?.id;
  const present = Boolean(remoteDatabaseId && remoteDatabaseId === binding?.database_id);
  const schema = present ? await d1SchemaStatus(databaseName) : 'missing';
  console.log(`kind=d1; resource=${databaseName ?? 'DB-unconfigured'}; present=${present}; schema=${schema}`);
  if (!present || schema !== 'v2-ready') process.exitCode = 1;
}

function create(kind, resource, args) {
  const result = run(args);
  const failureCategory = category(result.output);
  if (!result.ok && failureCategory === 'already-exists') {
    console.log(`kind=${kind}; resource=${resource}; result=already-present`);
    return;
  }
  if (!result.ok) throw new Error(`create ${kind} ${resource} failed (${failureCategory})`);
  console.log(`kind=${kind}; resource=${resource}; result=created`);
}

async function provision() {
  const checks = await audit();
  const present = new Map(checks.map(([kind, resource, exists]) => [`${kind}:${resource}`, exists]));
  if (!present.get('r2:inboxplease-media')) {
    create('r2', 'inboxplease-media', ['r2', 'bucket', 'create', 'inboxplease-media', '--location', 'apac']);
  }
  if (!present.get('queue:inboxplease-jobs')) create('queue', 'inboxplease-jobs', ['queues', 'create', 'inboxplease-jobs']);
  if (!present.get('queue:inboxplease-jobs-dead-letter')) {
    create('queue', 'inboxplease-jobs-dead-letter', ['queues', 'create', 'inboxplease-jobs-dead-letter']);
  }
  if (!present.get('vectorize:inboxplease-catalog')) {
    create('vectorize', 'inboxplease-catalog', [
      'vectorize', 'create', 'inboxplease-catalog',
      '--dimensions', '1024', '--metric', 'cosine',
      '--description', 'InboxPlease merchant catalog embeddings', '--json',
    ]);
  }
  const index = parseJsonOutput(
    run(['vectorize', 'get', 'inboxplease-catalog', '--json']),
    'read Vectorize configuration',
  );
  const vectorConfig = index.config ?? index.result?.config;
  if (vectorConfig?.dimensions !== 1024 || vectorConfig?.metric !== 'cosine') {
    throw new Error('Existing Vectorize index has incompatible dimensions or metric');
  }
  const metadata = run(['vectorize', 'list-metadata-index', 'inboxplease-catalog', '--json']);
  if (!includesName(metadata, 'page_id')) {
    create('vectorize-metadata', 'inboxplease-catalog/page_id', [
      'vectorize', 'create-metadata-index', 'inboxplease-catalog',
      '--propertyName', 'page_id', '--type', 'string',
    ]);
  }
  if (!present.get('pages:inboxplease-dashboard')) {
    create('pages', 'inboxplease-dashboard', [
      'pages', 'project', 'create', 'inboxplease-dashboard', '--production-branch', 'main',
    ]);
  }
  console.log('kind=d1; result=not-created-or-rebound; reason=requires-explicit-v2-approval');
}

if (command === 'audit') await audit({ strict: true });
if (command === 'audit-d1') await auditD1();
if (command === 'sync-d1') await syncD1Config();
if (command === 'provision') await provision();
