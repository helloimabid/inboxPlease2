import { readFile } from 'node:fs/promises';

const failures = [];
const envFilePath = process.argv[2];
let fileEnvironment = {};

if (envFilePath) {
  try {
    const source = await readFile(envFilePath, 'utf8');
    fileEnvironment = Object.fromEntries(source.split(/\r?\n/u).flatMap((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return [];
      const separator = line.indexOf('=');
      if (separator < 1) return [];
      return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
    }));
  } catch (error) {
    failures.push(
      error?.code === 'ENOENT'
        ? `production environment file not found: ${envFilePath}`
        : `production environment file could not be read: ${envFilePath}`,
    );
  }
}

const rawApiUrl = (
  process.env.VITE_API_URL ?? fileEnvironment.VITE_API_URL ?? ''
).trim();

let apiUrl;
try {
  apiUrl = new URL(rawApiUrl);
} catch {
  failures.push('VITE_API_URL must be an absolute URL');
}

if (apiUrl) {
  if (apiUrl.protocol !== 'https:') failures.push('VITE_API_URL must use HTTPS');
  if (apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1') {
    failures.push('VITE_API_URL must not point to localhost');
  }
  if (apiUrl.hostname.endsWith('.example.com')) {
    failures.push('VITE_API_URL still points at an example domain');
  }
  if (apiUrl.pathname.replace(/\/$/u, '') !== '/api') {
    failures.push('VITE_API_URL must end with /api');
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    failures.push('VITE_API_URL must not contain credentials, a query, or a fragment');
  }
}

if (failures.length > 0) {
  console.error('Dashboard production deploy blocked:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Dashboard production configuration guard passed.');
}
