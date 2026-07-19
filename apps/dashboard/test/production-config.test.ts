import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const validator = fileURLToPath(new URL('../scripts/validate-production-config.mjs', import.meta.url));
const productionEnvironment = fileURLToPath(new URL('../.env.production', import.meta.url));

function validate(apiUrl: string | undefined) {
  const env = { ...process.env };
  if (apiUrl === undefined) delete env.VITE_API_URL;
  else env.VITE_API_URL = apiUrl;
  return spawnSync(process.execPath, [validator], { env, encoding: 'utf8' });
}

describe('dashboard production configuration guard', () => {
  it('loads the checked-in production environment file used by the deploy command', () => {
    const env = { ...process.env };
    delete env.VITE_API_URL;
    const result = spawnSync(process.execPath, [validator, productionEnvironment], {
      env,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configuration guard passed');
  });

  it('accepts a credential-free HTTPS API URL ending in /api', () => {
    const result = validate('https://api.inboxplease.test/api');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('configuration guard passed');
  });

  it.each([
    [undefined, 'absolute URL'],
    ['http://api.inboxplease.test/api', 'must use HTTPS'],
    ['https://localhost/api', 'must not point to localhost'],
    ['https://api.example.com/api', 'example domain'],
    ['https://api.inboxplease.test/v1', 'must end with /api'],
    ['https://user:secret@api.inboxplease.test/api?token=secret', 'must not contain credentials'],
  ])('rejects %s', (apiUrl, expectedMessage) => {
    const result = validate(apiUrl);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dashboard production deploy blocked');
    expect(result.stderr).toContain(expectedMessage);
  });
});
