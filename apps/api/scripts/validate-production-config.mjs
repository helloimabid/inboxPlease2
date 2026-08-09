import { readFile } from 'node:fs/promises';
import { getDomain } from 'tldts';

const configSource = process.argv[2] ?? new URL('../wrangler.jsonc', import.meta.url);
const config = JSON.parse(await readFile(configSource, 'utf8'));
const vars = config.vars ?? {};
const databaseId = config.d1_databases?.[0]?.database_id ?? '';
const failures = [];

function isExactHttpsOrigin(value) {
  if (typeof value !== 'string' || value.includes(',')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username === '' && url.password === '' &&
      url.pathname === '/' && url.search === '' && url.hash === '' &&
      value === url.origin;
  } catch {
    return false;
  }
}

function sameCookieSite(leftValue, rightValue) {
  let left;
  let right;
  try {
    left = new URL(leftValue);
    right = new URL(rightValue);
  } catch {
    return false;
  }
  if (left.protocol !== right.protocol) return false;
  if (left.hostname === right.hostname) return true;
  // Browser SameSite uses the registrable domain. Include the PSL private
  // section so provider-owned tenants such as *.pages.dev and *.vercel.app
  // are not mistaken for sibling custom domains.
  const options = { allowPrivateDomains: true };
  const leftSite = getDomain(left.hostname, options);
  const rightSite = getDomain(right.hostname, options);
  return Boolean(leftSite && rightSite && leftSite === rightSite);
}

if (!databaseId || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)) {
  failures.push('replace the placeholder D1 database_id');
}
if (vars.ENVIRONMENT !== 'production' || vars.DEV_MODE !== 'false') {
  failures.push('keep ENVIRONMENT=production and DEV_MODE=false');
}
if (vars.D1_SCHEMA_READY !== 'true') {
  failures.push('D1_SCHEMA_READY must be exactly true after schema reconciliation and migrations');
}
if (vars.AUTH_PASSWORD_FALLBACK_ENABLED !== 'false') {
  failures.push('AUTH_PASSWORD_FALLBACK_ENABLED must remain false for normal production seller access');
}
// if (vars.PROACTIVE_ORDER_UPDATES_ENABLED !== 'false') {
//   failures.push('PROACTIVE_ORDER_UPDATES_ENABLED must remain false until customer opt-in and Meta eligibility are enforced');
// }
if (typeof vars.AUTH_FACEBOOK_ID !== 'string' || !/^\d+$/.test(vars.AUTH_FACEBOOK_ID)) {
  failures.push('AUTH_FACEBOOK_ID must be the numeric ID of the Facebook login app');
}
if (
  Object.prototype.hasOwnProperty.call(vars, 'META_APP_ID') &&
  (typeof vars.META_APP_ID !== 'string' || !/^\d+$/.test(vars.META_APP_ID))
) {
  failures.push('META_APP_ID must be the numeric ID of the Messenger-capable Meta app');
}
for (const [key, value] of [
  ['DASHBOARD_ORIGIN', vars.DASHBOARD_ORIGIN],
  ['PUBLIC_API_BASE_URL', vars.PUBLIC_API_BASE_URL],
]) {
  if (!isExactHttpsOrigin(value) || value.includes('localhost')) {
    failures.push(`${key} must be one canonical HTTPS origin with no path, query, fragment, credentials, or comma list`);
  }
}
if (Object.prototype.hasOwnProperty.call(vars, 'AUTH_URL')) {
  failures.push(
    'AUTH_URL must be omitted because Auth.js uses the explicit /authjs basePath and canonical request host',
  );
}
if (config.workers_dev !== false) {
  failures.push('workers_dev must be false so production auth has no alternate Worker origin');
}
if (isExactHttpsOrigin(vars.PUBLIC_API_BASE_URL)) {
  const authHost = new URL(vars.PUBLIC_API_BASE_URL).hostname;
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const hasCanonicalRoute = routes.some((route) => {
    if (!route || typeof route !== 'object' || route.custom_domain !== true) return false;
    return route.pattern === authHost || route.pattern === `${authHost}/*`;
  });
  if (!hasCanonicalRoute) {
    failures.push('configure a custom_domain Worker route matching the PUBLIC_API_BASE_URL hostname');
  }
}
if (
  isExactHttpsOrigin(vars.DASHBOARD_ORIGIN) &&
  isExactHttpsOrigin(vars.PUBLIC_API_BASE_URL) &&
  !sameCookieSite(vars.DASHBOARD_ORIGIN, vars.PUBLIC_API_BASE_URL)
) {
  failures.push(
    'DASHBOARD_ORIGIN and PUBLIC_API_BASE_URL must be same-site custom domains or the same proxied origin for Auth.js cookies',
  );
}
for (const key of ['AUTH_SECRET', 'AUTH_FACEBOOK_SECRET', 'META_APP_SECRET']) {
  if (Object.prototype.hasOwnProperty.call(vars, key)) {
    failures.push(`${key} must be a Worker secret, not a plaintext wrangler var`);
  }
}
if (vars.PAYMENTS_ENABLED === 'true') {
  for (const key of ['SSLCOMMERZ_INIT_URL', 'SSLCOMMERZ_VALIDATION_URL']) {
    const value = vars[key];
    if (typeof value !== 'string' || value.includes('sandbox')) {
      failures.push(`${key} still points at a sandbox or is missing while payments are enabled`);
    }
  }
}

if (failures.length > 0) {
  console.error('Production deploy blocked:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Production configuration guard passed.');
}
