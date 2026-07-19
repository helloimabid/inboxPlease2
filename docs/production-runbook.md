# Production runbook

## 1. Provision Cloudflare resources

Keep the Cloudflare account ID and API token in the ignored repository-root `.env.local`
using `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Audit first:

```bash
npm run cloudflare:audit
```

This audit is read-only but strict. It reports every resource and exits nonzero unless
the exact configured D1 name/ID and full current schema contract are ready.

R2 `inboxplease-media`, Queue `inboxplease-jobs`, dead-letter Queue
`inboxplease-jobs-dead-letter`, the 1,024-dimension cosine Vectorize index
`inboxplease-catalog` with a string metadata index for `page_id`, and Pages project
`inboxplease-dashboard` are provisioned. The checked-in provisioning command is
idempotent and validates the existing resources before continuing:

```bash
npm run cloudflare:provision
```

Provisioning creates persistent external resources that may be billable. Obtain explicit
approval for those named resources before running it. The command deliberately neither
creates nor rebinds D1.

### D1 status and migration boundary

The deployment owner deleted the incompatible legacy D1. A fresh APAC database named
`inboxplease` is now bound as `DB`, has the exact `0001`-`0010` migration ledger, and
passes the complete column, trigger, constraint, index, and foreign-key audit as
`schema=v2-ready`. No legacy data was imported.

Wrangler's ordered SQL files remain the deployment source of truth. Drizzle Kit output
must be reviewed and converted to a numbered migration rather than pushed directly.
Every future remote apply still requires an explicit database name and the exact pending
migration list:

```powershell
$env:INBOXPLEASE_D1_NAME='inboxplease'
$env:INBOXPLEASE_APPROVED_MIGRATIONS='<exact comma-separated pending files>'
npm run db:migrate:remote --workspace @inboxplease/api
Remove-Item Env:INBOXPLEASE_APPROVED_MIGRATIONS
```

The wrapper checks the exact target, migration ledger, schema prefix, Auth.js columns,
and foreign keys before any write. Re-run `npm run cloudflare:audit` after every schema
change. If it does not report `schema=v2-ready`, immediately set
`D1_SCHEMA_READY=false` before deployment or background processing.

The Durable Object migrations in Wrangler are append-only. Do not edit a deployed migration tag; add a new tag for every new class or storage migration.

The Worker has a one-minute cron that republishes due `outbox_events`, removes expired
Facebook onboarding candidates, and reconciles each Page's desired app-subscription
state after ambiguous or reordered Meta responses. Keep this trigger enabled in every
production environment; request-path work is the fast path and the scheduled sweep is
the repair path.

## 2. Configure secrets

Set at least the following with `wrangler secret put`:

- `AUTH_FACEBOOK_SECRET` (seller login app)
- `META_APP_SECRET` (Messenger-capable Page authorization and webhook app)
- `META_VERIFY_TOKEN`
- `META_TOKEN_ENCRYPTION_KEY` (base64-encoded 32-byte AES key for per-Page token envelopes)
- `SSLCOMMERZ_STORE_ID`
- `SSLCOMMERZ_STORE_PASSWORD`
- `AUTH_SECRET` (at least 32 random bytes)

Set `AUTH_FACEBOOK_ID` to the login app's public numeric ID and `META_APP_ID` to the
Messenger app's public numeric ID. Set `PUBLIC_API_BASE_URL` to the canonical API
origin. Keep `AUTH_URL` unset because Auth.js declares `/authjs` explicitly. Register
each exact OAuth redirect URI in its corresponding app:

```text
<PUBLIC_API_BASE_URL>/authjs/callback/facebook
<PUBLIC_API_BASE_URL>/facebook/callback
```

The first callback belongs to the login app. The second belongs to the Messenger app
created with the **Engage with customers on Messenger from Meta** use case; neither
callback substitutes for the webhook URL below.

Keep `AUTH_PASSWORD_FALLBACK_ENABLED=false` for normal production traffic. Enabling it
reopens the legacy password endpoints and Credentials provider and is reserved for an
explicit, time-bounded recovery procedure.

`META_PAGE_ACCESS_TOKEN` is an optional single-Page bootstrap secret, not a multi-tenant credential store. Page-specific tokens in D1 must be `enc.v1` AES-GCM envelopes produced with `META_TOKEN_ENCRYPTION_KEY`; the Worker rejects plaintext database tokens in production.

Migrations `0008_auth_accounts.sql` and `0009_authjs_drizzle.sql` configure the
first-party account flow plus the shared Auth.js/Drizzle identity schema. Auth.js uses its
fixed adapter tables and is mounted at `/authjs/*`; schema changes occur through Wrangler
migrations, not a per-request `up()` call. `AUTH_SECRET` signs the short-lived merchant
bearer JWTs and protects Auth.js session tokens; it must exist only as a Worker secret. Passwords
are stored as PBKDF2-SHA256 digests with random salts; D1 also tracks hashed email/IP
failure buckets for basic signin throttling. The dashboard stores its bearer token in
sessionStorage under `inboxplease.session-token`; do not expose passwords or tokens
through a `VITE_*` variable, URL, localStorage, logs, or checked-in configuration. Add
Cloudflare edge rate limiting and bot controls to public authentication endpoints before
broad launch.

Keep `ENVIRONMENT=production` and `DEV_MODE=false`. Change `D1_SCHEMA_READY` to `true`
only after the current binding passes the complete schema audit including `0010`. Set
`AI_GATEWAY_ID=inboxplease-prod`, replace
`DASHBOARD_ORIGIN` and `PUBLIC_API_BASE_URL` with the exact HTTPS production origins, and
configure an AI Gateway spend limit, logging policy, cache policy, and retry policy in
Cloudflare. Deployment must fail closed; `X-Dev-Merchant-Id` is accepted only when both
local-development conditions are explicitly enabled through `.dev.vars`. Production
dashboard builds also fail closed when a session is missing or the API is unavailable;
demo data is limited to the Vite development server.

## 3. Accept the vision model terms

Cloudflare requires the Meta Llama 3.2 Vision license to be accepted once on the account. Send the documented one-time `prompt: "agree"` inference before enabling image analysis.

## 4. Configure Meta

First complete the
[Meta production compliance and deletion checklist](meta-production-compliance.md).
The public Privacy Policy and Terms must match the product's actual data flows, and the
Meta App Dashboard must point to a working user-data deletion callback or instructions
page. A database user-delete trigger is not a complete account-deletion workflow.

Point the Messenger webhook at:

```text
https://<worker-domain>/webhooks/meta
```

Subscribe to `messages`, `messaging_postbacks`, `messaging_handovers`, and the fields used by the selected Graph API version. Use the same verify token stored in the Worker. Complete App Review for `pages_messaging` and related permissions before serving merchants outside development accounts.

Pin the Graph API version through configuration and schedule a periodic upgrade review. Meta versions age out; do not hard-code a version forever without monitoring.

Proactive order messaging is hard-off in both the runtime and production validator until
InboxPlease persists and enforces customer opt-in, Meta entitlement, message category,
and the allowed delivery window. Meta approval or a feature flag alone is not sufficient.
The `HUMAN_AGENT` tag is for human-composed support only; automated AI sends must remain
disabled while another receiver owns the conversation.

## 5. Configure SSLCommerz

Point IPN and payment callbacks at:

```text
https://<worker-domain>/webhooks/sslcommerz
```

Enable sandbox mode first. A callback is only a signal: verify its hash, validate the transaction with SSLCommerz server-to-server, compare status, server-generated transaction ID, amount, currency, store identity, and risk level, then rely on the unique transaction constraint before marking an order paid. Store amounts as integer paisa and render exact decimal BDT values only at the gateway boundary.

Confirm whether the live merchant account requires source-IP allowlisting, particularly for refunds. Workers do not provide a fixed egress IP by default; use an approved fixed-egress service if SSLCommerz requires one.

## 6. Deploy and verify

Before the static dashboard build, set `VITE_API_URL` to the API's exact HTTPS URL ending
in `/api` (for example, `https://api.example.com/api`). The auth client uses the
same API origin for `/authjs/*`; register
`<PUBLIC_API_BASE_URL>/authjs/callback/facebook`. Keep `AUTH_URL` unset to avoid defining
the Auth.js base path twice. Set `DASHBOARD_ORIGIN` on the Worker to
the exact Pages HTTPS origin so browser CORS requests fail closed to every other origin.
The dashboard deploy command validates this value and refuses localhost/example URLs.
For Auth.js cookie sessions, serve the dashboard and API from same-site custom domains
(for example, `app.example.com` and `api.example.com`); the first-party bearer flow
remains available when separate provider domains would block third-party cookies.
Set `workers_dev=false` and add a `custom_domain: true` Worker route whose pattern is the
exact `PUBLIC_API_BASE_URL` hostname. The production validator rejects an alternate `workers.dev`
origin, a missing custom route, or a route that does not match the canonical auth host.

```bash
npm run check
npm run deploy:api
npm run deploy:dashboard
```

The API deploy command reruns the static production guard and the strict read-only
Cloudflare/D1 audit before invoking Wrangler. A literal schema flag cannot bypass a
pending migration or drifted binding.

Smoke-test `/health`, Facebook login/new-seller bootstrap, OAuth state and redirect
rejection, a Facebook profile without email, `/api/account/me`, Page permission consent
and denial, webhook verification, invalid signatures, duplicate and reordered inbound
events, ignored echoes, a Bangla text conversation, a voice note, image matching, handoff
and resume, quota-boundary concurrency, payment validation and tampering, retry and
dead-letter behavior, Durable Object eviction, and cross-binding tenant isolation before
inviting production merchants.

After migration 0007, pre-existing idempotent orders have no request fingerprint. Replays of those legacy keys intentionally fail closed; clients should use a new key. New order replays return the original order only when the normalized request fingerprint matches exactly.

## 7. Operational alerts

Alert on queue backlog and dead letters, webhook signature failures, AI error rate, AI Gateway spend, frontier-escalation rate, low-confidence streaks, Messenger delivery failures, D1 size and query latency, and Durable Object exception counts. Also alert when pending/leased outbox rows age beyond two cron intervals or any outbox row reaches `failed`; inspect `attempts` and `last_error` before replaying it. Review real Banglish conversation quality before tuning routing thresholds.

Useful outbox health query:

```sql
SELECT status, COUNT(*) AS events, MIN(created_at) AS oldest
FROM outbox_events
WHERE status <> 'dispatched'
GROUP BY status;
```
