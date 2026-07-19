# InboxPlease

InboxPlease is a Bangla-first conversational commerce platform for Facebook sellers. It combines a React merchant dashboard with a Hono API on Cloudflare Workers, tenant-scoped Durable Objects, D1, Workers AI, Vectorize, R2, Queues, Meta Messenger, and SSLCommerz.

This repository implements the production-oriented core of the v2 architecture. Real external calls are guarded by configuration, while the dashboard and API expose deterministic demo data for local development. External onboarding, billing, and launch prerequisites are tracked explicitly rather than hidden behind mock credentials.

## Repository layout

```text
apps/
  api/        Hono Worker, Durable Objects, D1 migrations, integrations, tests
  dashboard/  Vite + React merchant dashboard
docs/         Architecture decisions and production runbook
```

## Prerequisites

- Node.js 20.19 or newer
- A Cloudflare account with Workers Paid, Workers AI, D1, Durable Objects, R2, Queues, and Vectorize enabled for production deployment
- Meta app/Page credentials and SSLCommerz credentials only when enabling those integrations

## Local setup

```bash
npm install
npm run db:migrate:local --workspace @inboxplease/api
```

Run the API and dashboard development servers in separate terminals. Keep both running while developing locally:

Terminal 1 — API Worker:

```bash
npm run dev:api
```

Terminal 2 — dashboard:

```bash
npm run dev:dashboard
```

To inspect the local Auth.js identity tables visually, open a third terminal:

```bash
npm run db:studio
```

The guarded launcher applies local migrations, verifies the exact migration ledger and
Auth.js columns, then starts Drizzle Studio on `127.0.0.1:4983`. Open
`https://local.drizzle.studio` and inspect `users`, `accounts`, `sessions`,
`verification_tokens`, `merchant_memberships`, and `auth_login_attempts`. Studio can edit
data, so this command is deliberately local-only; it contains no remote D1 credentials.

The dashboard defaults to `http://localhost:5173` and proxies `/api` to the Worker at `http://localhost:8787`. Its Hono `hc<AppType>()` client imports the Worker route type without bundling Worker code. Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` to enable the explicit local identity and configure local-only secrets. Never commit `.dev.vars`. The Vite development server may show preview data when the API is unavailable; production builds never fall back to demo data.

Run all verification:

```bash
npm run check
```

## Production resources

Cloudflare credentials are read only from the ignored repository-root `.env.local` as
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; never place them in the dashboard
environment because Vite variables are public. Start from `.env.local.example`, then
audit the account without making changes:

```bash
npm run cloudflare:audit
```

The audit is read-only and strict: it prints every resource, but exits nonzero if any
resource is missing, the configured D1 name/ID does not match, or the complete ledger,
tables, columns, indexes, constraints, triggers, and foreign keys are not ready.

`npm run cloudflare:provision` is idempotent, but it creates persistent resources that may
be billable. Run it only after approving the named resources in the production runbook.
It deliberately does not create or rebind D1. `cloudflare:sync-d1` requires an explicit
`INBOXPLEASE_D1_NAME` and refuses a database that is neither empty nor an exact v2 schema.

The R2 bucket, Queue, dead-letter Queue, 1,024-dimension cosine Vectorize index with its
`page_id` string metadata index, and Pages project are provisioned. After the deployment
owner deleted the incompatible legacy database, a fresh APAC D1 named `inboxplease` was
created, bound, migrated through `0010_facebook_page_onboarding.sql`, and audited as
`schema=v2-ready`. No legacy data was imported. The selected production origins are
`https://inboxplease2.helloimabid.com` and
`https://api.inboxplease2.helloimabid.com`; deployment remains blocked until the required
Facebook app ID and Worker secrets are configured. See the
[production runbook](docs/production-runbook.md), [retired legacy note](docs/legacy-d1-cutover.md),
and [readiness boundary](docs/production-readiness.md).

## Important architecture choices

- Qwen3-30B-A3B is the default text model. Claude Haiku 4.5 is reached through AI Gateway only for complaints, carts worth at least ৳5,000, or repeated low-confidence replies.
- Bangla voice notes use multilingual `@cf/openai/whisper-large-v3-turbo`.
- Vectorize uses cosine similarity, with scores interpreted on the cosine scale and a configurable `0.55` candidate threshold.
- D1 is the central MVP store. The data-access boundary and migration notes keep a future Postgres move explicit rather than pretending D1's 10 GB database limit can be raised.
- Durable Object identities always include both `page_id` and customer/page scope, and every D1 query is merchant-scoped.

## Security posture

Meta webhook signatures are verified against a size-bounded raw request body, webhook verification uses a timing-safe comparison, dashboard routes require a signed session identity outside explicit local-demo mode, and payment updates are idempotent. Per-Page Meta tokens are AES-GCM envelopes in production; global bootstrap credentials and encryption keys belong in Wrangler secrets or Cloudflare-managed bindings, never source control.

Sellers enter through Facebook OAuth at `/authjs/*`; the exact registered callback is
`<PUBLIC_API_BASE_URL>/authjs/callback/facebook`. First login creates the seller's free merchant and
owner membership, including when Facebook returns no email. Login asks only for identity
scope, never auto-links a same-email account, and does not retain its short-lived Facebook
access token. Password signin is an explicit break-glass fallback and password signup is
local-development-only. Auth.js sessions map into the same merchant/role authorization
boundary. Drizzle ORM is the runtime query layer for users, memberships, merchants, and
signin throttling. Wrangler migrations remain the deployment source of truth; migration
`0009` upgrades the shared user table and creates the fixed Auth.js adapter tables. Never
put a secret or bearer token in a `VITE_*` variable, URL, localStorage, or source file.
The separate Page consent callback is `<PUBLIC_API_BASE_URL>/facebook/callback`; it keeps
Page tokens encrypted and requires webhook readiness plus an explicit seller approval
before AI messaging can become effective.
See the [Facebook seller login and Page approval guide](docs/facebook-onboarding.md) for
the exact callbacks, permissions, secrets, and activation invariants, and the
[Meta production compliance checklist](docs/meta-production-compliance.md) for the
remaining Privacy Policy, Terms, deletion, Page reclaim, and production-domain gates.
Catalog, settings, and media writes require `owner` or `admin`; order writes also allow
`staff`; authenticated reads remain available to `service` identities.
