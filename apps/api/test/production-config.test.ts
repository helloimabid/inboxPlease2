import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const validator = fileURLToPath(
  new URL('../scripts/validate-production-config.mjs', import.meta.url),
);
const remoteMigration = fileURLToPath(
  new URL('../scripts/migrate-remote.mjs', import.meta.url),
);
const directories: string[] = [];

function validate(vars: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'inboxplease-config-'));
  directories.push(directory);
  const path = join(directory, 'wrangler.json');
  writeFileSync(path, JSON.stringify({
    vars,
    workers_dev: false,
    routes: [{
      pattern: new URL(vars.PUBLIC_API_BASE_URL ?? 'https://api.example.com').hostname,
      custom_domain: true,
    }],
    d1_databases: [{ database_id: '11111111-1111-4111-8111-111111111111' }],
  }));
  return spawnSync(process.execPath, [validator, path], { encoding: 'utf8' });
}

function validVars(): Record<string, string> {
  return {
    ENVIRONMENT: 'production',
    DEV_MODE: 'false',
    D1_SCHEMA_READY: 'true',
    DASHBOARD_ORIGIN: 'https://dashboard.example.com',
    PUBLIC_API_BASE_URL: 'https://api.example.com',
    AUTH_FACEBOOK_ID: '1234567890',
    AUTH_PASSWORD_FALLBACK_ENABLED: 'false',
    PROACTIVE_ORDER_UPDATES_ENABLED: 'false',
    PAYMENTS_ENABLED: 'false',
    SSLCOMMERZ_INIT_URL: 'https://sandbox.sslcommerz.com/init',
    SSLCOMMERZ_VALIDATION_URL: 'https://sandbox.sslcommerz.com/validate',
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('production configuration validator', () => {
  it('accepts canonical origins and permits sandbox payment URLs while payments are disabled', () => {
    const result = validate(validVars());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    'https://dashboard.example.com/',
    'https://dashboard.example.com/path',
    'https://dashboard.example.com?preview=1',
    'https://dashboard.example.com#fragment',
    'https://user:password@dashboard.example.com',
    'https://dashboard.example.com,https://evil.example.com',
  ])('rejects non-origin DASHBOARD_ORIGIN value %s', (origin) => {
    const result = validate({ ...validVars(), DASHBOARD_ORIGIN: origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DASHBOARD_ORIGIN must be one canonical HTTPS origin');
  });

  it('rejects sandbox payment endpoints only when payments are enabled', () => {
    const result = validate({ ...validVars(), PAYMENTS_ENABLED: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('while payments are enabled');
  });

  it('requires the canonical Facebook app ID and keeps password recovery closed', () => {
    const missingApp = validate({ ...validVars(), AUTH_FACEBOOK_ID: '' });
    expect(missingApp.status).toBe(1);
    expect(missingApp.stderr).toContain('AUTH_FACEBOOK_ID');

    const passwordEnabled = validate({
      ...validVars(),
      AUTH_PASSWORD_FALLBACK_ENABLED: 'true',
    });
    expect(passwordEnabled.status).toBe(1);
    expect(passwordEnabled.stderr).toContain('AUTH_PASSWORD_FALLBACK_ENABLED');
  });

  it('accepts a separate Messenger app ID and rejects an invalid one', () => {
    const separateApps = validate({ ...validVars(), META_APP_ID: '9988776655' });
    expect(separateApps.status, `${separateApps.stdout}\n${separateApps.stderr}`).toBe(0);

    const invalid = validate({ ...validVars(), META_APP_ID: 'not-an-app-id' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('META_APP_ID');
  });

  it('rejects AUTH_URL because the explicit Auth.js base path is canonical', () => {
    const result = validate({
      ...validVars(),
      AUTH_URL: 'https://api.example.com/authjs',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTH_URL must be omitted');
  });

  it('keeps proactive order messaging closed until policy eligibility is persisted', () => {
    const result = validate({
      ...validVars(),
      PROACTIVE_ORDER_UPDATES_ENABLED: 'true',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PROACTIVE_ORDER_UPDATES_ENABLED');
  });

  it('requires a same-site dashboard and API for the Auth.js session cookie', () => {
    const providerDomains = validate({
      ...validVars(),
      DASHBOARD_ORIGIN: 'https://inboxplease-dashboard.pages.dev',
      PUBLIC_API_BASE_URL: 'https://inboxplease-api.example.workers.dev',
    });
    expect(providerDomains.status).toBe(1);
    expect(providerDomains.stderr).toContain('same-site custom domains');

    const unrelated = validate({
      ...validVars(),
      DASHBOARD_ORIGIN: 'https://dashboard.example.com',
      PUBLIC_API_BASE_URL: 'https://api.example.net',
    });
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain('same-site custom domains');

    const privateSuffix = validate({
      ...validVars(),
      DASHBOARD_ORIGIN: 'https://seller-ui.vercel.app',
      PUBLIC_API_BASE_URL: 'https://seller-api.vercel.app',
    });
    expect(privateSuffix.status).toBe(1);
    expect(privateSuffix.stderr).toContain('same-site custom domains');
  });

  it('requires one canonical custom-domain Worker origin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inboxplease-config-'));
    directories.push(directory);
    const path = join(directory, 'wrangler.json');
    writeFileSync(path, JSON.stringify({
      vars: validVars(),
      workers_dev: true,
      routes: [],
      d1_databases: [{ database_id: '11111111-1111-4111-8111-111111111111' }],
    }));
    const result = spawnSync(process.execPath, [validator, path], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workers_dev must be false');
    expect(result.stderr).toContain('custom_domain Worker route');
  });

  it('blocks remote migration before network access without an explicit matching database name', () => {
    const missing = spawnSync(process.execPath, [remoteMigration], {
      encoding: 'utf8',
      env: { ...process.env, INBOXPLEASE_D1_NAME: '', INBOXPLEASE_APPROVED_MIGRATIONS: '' },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('set INBOXPLEASE_D1_NAME');

    const mismatched = spawnSync(process.execPath, [remoteMigration], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INBOXPLEASE_D1_NAME: 'not-the-configured-database',
        INBOXPLEASE_APPROVED_MIGRATIONS: '0001_initial.sql',
      },
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain('does not exactly match');
  });
});
