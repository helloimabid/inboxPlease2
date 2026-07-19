import { readFile, writeFile } from 'node:fs/promises';

const rootEnvPath = new URL('../.env.local', import.meta.url);
const legacyEnvPath = new URL('../apps/dashboard/.env.example', import.meta.url);

function parseEnv(source) {
  const entries = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }
  return entries;
}

async function readOptional(url) {
  try {
    return await readFile(url, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    throw error;
  }
}

const rootEntries = parseEnv(await readOptional(rootEnvPath));
const legacyEntries = parseEnv(await readOptional(legacyEnvPath));
const accountId = rootEntries.get('CLOUDFLARE_ACCOUNT_ID')
  ?? rootEntries.get('account-id')
  ?? legacyEntries.get('account-id');
const apiToken = rootEntries.get('CLOUDFLARE_API_TOKEN')
  ?? rootEntries.get('api-key')
  ?? legacyEntries.get('api-key');

if (!accountId || !apiToken) {
  throw new Error('Cloudflare account ID and API token must both be present');
}

const retained = [...rootEntries.entries()].filter(([key]) => ![
  'account-id',
  'api-key',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
].includes(key));
const normalized = [
  ...retained,
  ['CLOUDFLARE_ACCOUNT_ID', accountId],
  ['CLOUDFLARE_API_TOKEN', apiToken],
];
await writeFile(
  rootEnvPath,
  `${normalized.map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

console.log('normalized_keys=CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN');
console.log('values=present; values_printed=false');
