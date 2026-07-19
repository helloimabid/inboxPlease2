# InboxPlease API

Hono + TypeScript Cloudflare Worker for the InboxPlease v2 architecture.

## Local setup

1. Copy `.dev.vars.example` to `.dev.vars` and provide local-only secrets. This
   is what explicitly enables the development authentication fallback; deploy
   defaults remain fail-closed.
2. Run `npm run db:migrate:local`, then `npm run dev`.

The checked-in remote `DB` binding identifies the fresh APAC v2 database. Migrations
`0001`–`0009` and the complete Auth.js column contract were remotely audited. Migration
`0010_facebook_page_onboarding.sql` is verified locally but remains pending remotely, so
`D1_SCHEMA_READY=false` stays closed until that exact migration and its foreign keys are
remotely audited. Production deployment also requires canonical HTTPS origins and the
documented Worker secrets.

External AI, messaging, payments, proactive order updates, and vector search are disabled by default. Enable them deliberately through Worker variables after their corresponding bindings, credentials, Meta permissions, and AI Gateway budgets are configured. Never enable `DEV_MODE` in production.

Catalog, settings, order-status, and order-stock side effects use a transactional D1 outbox. Keep the configured one-minute cron enabled: it republishes due events if the nonblocking eager Queue send fails. Queue consumers deduplicate by the outbox event ID.

## Dashboard sessions and roles

Facebook OAuth is the seller login and signup path. Auth.js is mounted at `/authjs/*`,
the provider ID is `facebook`, and the exact production redirect registered in the Meta
app must be `<PUBLIC_API_BASE_URL>/authjs/callback/facebook`. Set the public app ID as
`AUTH_FACEBOOK_ID`, and set `AUTH_FACEBOOK_SECRET` plus `AUTH_SECRET` with
`wrangler secret put`; never place either secret in `wrangler.jsonc`. The Page connection
can use a separate Messenger-capable app through `META_APP_ID` and the
`META_APP_SECRET` Worker secret. Auth.js uses the
explicit `/authjs` base path and canonical request host; do not also set `AUTH_URL`.
Login requests only `public_profile`. The separate Page connection requests only
`pages_show_list`, `pages_manage_metadata`, and `pages_messaging`, lists Pages the
seller already manages, and requires explicit Page selection plus AI-messaging
approval before it stores a Page token or enables messaging.

That second flow starts at `POST /api/facebook/connect`; register
`<PUBLIC_API_BASE_URL>/facebook/callback` as its exact redirect. The callback uses a
hashed one-time state, requires the same active InboxPlease user and merchant session
that initiated authorization, requires the Page-management and messaging grants, and stores selectable Page
tokens only as AES-GCM envelopes. Page approval subscribes the webhook and records the
approving user and timestamp. Seller enablement remains separate from the
`AI_ENABLED`/`MESSAGING_ENABLED` platform kill switches. See
`docs/facebook-onboarding.md` for the complete setup.

On the first successfully linked Facebook login, the JWT callback idempotently creates
a free-plan merchant and owner membership. Facebook accounts without an email are
supported. Auth.js's safe default is retained: a Facebook identity is not automatically
linked to a pre-existing same-email user unless that user is already authenticated.
The short-lived Facebook login token is deliberately not persisted in `accounts`.
`GET /api/account/me` resolves the resulting merchant-scoped identity.

The old password signin API and Auth.js Credentials provider are break-glass compatibility
paths only. Both are unavailable unless `AUTH_PASSWORD_FALLBACK_ENABLED=true` is set
explicitly for a local session or controlled recovery procedure; password signup remains
local-development-only, and normal production must keep the switch `false`. Auth.js uses a seven-day encrypted HttpOnly JWT cookie. The official
`@auth/d1-adapter` remains migration-tested for user, account, database-session, and
verification-token CRUD.

Migration `0009_authjs_drizzle.sql` rebuilds the existing `users` table as an Auth.js-compatible superset without changing user IDs, password digests, or merchant memberships. Adapter writes to `email` are synchronized to `email_normalized` by D1 triggers. Every bearer or Auth.js-cookie request rechecks the active user, exact active membership role, and active merchant, so disabling or revoking an account invalidates access immediately.

Roles are intentionally narrow: `owner` and `admin` may mutate catalog, settings, and media; `owner`, `admin`, and `staff` may create, check out, or transition orders; `service` may use authenticated reads but cannot use dashboard mutations. The local development identity is an `owner` only when the explicit development fallback is enabled.

## Drizzle schema and migrations

Runtime queries use `drizzle-orm/d1` with `src/db/schema.ts`. `drizzle-kit` is available through `npm run db:auth:schema:generate`, but its `drizzle-auth/` output is a review artifact only. Production schema changes must be promoted into a deterministic, numbered SQL file under `migrations/` and applied once with Wrangler; the Worker never migrates on request startup.

Run `npm run db:studio` to browse the local Auth.js schema in Drizzle Studio. The launcher
first applies local Wrangler migrations, then selects only a local D1 SQLite file with the
exact current ledger, complete Auth.js column contract, and no foreign-key violations. It
binds the Studio proxy to `127.0.0.1`; Studio is mutable, so treat it as a local development
tool rather than a read-only viewer. `npm run db:studio:check` performs the target audit
without starting Studio. Remote `d1-http` Studio access is intentionally not configured;
the default workflow cannot mutate the remote D1 database.

Use `npm run db:migrate:local` for the local `DB` binding. The `db:migrate:remote` wrapper requires `INBOXPLEASE_D1_NAME` to exactly match the configured database name and `INBOXPLEASE_APPROVED_MIGRATIONS` to exactly list the pending files. It then checks the remote ledger and `sqlite_master` for an empty database or a contiguous, column-compatible v2 prefix before applying by explicit database name. The fresh remote database is migrated through `0009`; `0010_facebook_page_onboarding.sql` requires separate explicit approval before its guarded remote apply.

The remote `inboxplease` database has the exact `0001`–`0009` ledger. Checked-in
production configuration sets `D1_SCHEMA_READY=false` while `0010` is pending. Reopen the
gate only after the updated ledger, columns, triggers, and foreign keys pass audit. If the
binding or schema ever changes, close the gate before any deployment and reopen it only
after the same ledger, column, and foreign-key audit.
Explicit local development mode remains isolated from the remote database.

The Vectorize index must use 1,024 dimensions, cosine distance, and a string metadata index for `page_id`. Accept the Meta license for the Llama 3.2 vision model once before enabling vision requests.

## Verification

Run `npm run check` for strict TypeScript checking, unit tests, and a Wrangler dry-run build.
