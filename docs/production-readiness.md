# Production readiness boundary

This repository is a production-oriented MVP scaffold, not a deploy-without-configuration appliance. The safe local path works with integrations disabled. Before serving real merchants, the deployment owner must complete the following external setup.

## Required before production traffic

- R2, Queue, dead-letter Queue, Vectorize, Pages, and the fresh APAC D1 now exist. D1 is bound, migrated through `0010_facebook_page_onboarding.sql`, and passes the complete remote `schema=v2-ready` audit. No legacy data was imported.
- The selected same-site production origins are `https://inboxplease2.helloimabid.com` for the dashboard and `https://api.inboxplease2.helloimabid.com` for the Worker. Use live SSLCommerz endpoints only after sandbox certification.
- Keep account migrations `0008` and `0009` in the verified ledger; configure
  `AUTH_SECRET`, `AUTH_FACEBOOK_ID`, `AUTH_FACEBOOK_SECRET`, `META_APP_ID`,
  `META_APP_SECRET`, and the exact HTTPS
  `PUBLIC_API_BASE_URL`; and register
  `<PUBLIC_API_BASE_URL>/authjs/callback/facebook` in the login app. Register
  `<PUBLIC_API_BASE_URL>/facebook/callback` and the Messenger webhook in the separate
  Messenger-capable app. Keep `AUTH_URL` unset because the Worker config declares
  `/authjs` explicitly.
  Keep password fallback disabled and protect the public Auth.js endpoints with Cloudflare
  rate limiting and bot controls. No credential is compiled into the dashboard bundle.
- Complete Meta App Review/Advanced Access and staging validation for the implemented Page OAuth flow. Configure the 32-byte token-encryption key as a Worker secret (or replace it with managed opaque secret references); plaintext Page tokens are rejected in production.
- Publish accurate Privacy Policy and Terms pages; configure and test Facebook user-data
  deletion; implement the complete seller/workspace deletion job; and retain the current
  fail-closed Page claim until an audited cross-tenant reclaim workflow exists. See the
  [Meta production compliance checklist](meta-production-compliance.md).
- Keep all D1 migrations current, accept the selected vision-model terms, and configure Queue/AI/D1/DO observability and alerts. The Vectorize `page_id` metadata index is already present.
- Keep messaging, payments, AI, and Vectorize fallback disabled until their credentials and policy approvals are verified independently. Proactive order updates are additionally hard-off until customer opt-in and Meta eligibility are represented and enforced in the data model.

## Deliberately deferred product work

- The architecture brief explicitly leaves monthly AI quota-counter design open. Current usage rows are metering, not a billing-grade quota system; launch requires atomic plan enforcement and overage handling.
- Live Meta App Review and real-account Page onboarding validation, subscription billing, refund execution, and staff-management UI remain integration work; the Facebook login, Page selection, explicit approval, encryption, and send gates are implemented locally.
- The dashboard reads live account, summary, catalog, and order data and can create a product. Catalog edits, order actions, settings mutations, and inbox synchronization still require complete RPC mutation and optimistic/error workflows.
- Text replies are grounded with cached merchant settings and catalog facts. Structured cart extraction, cart-item mutations, checkout tool calls, and billing-grade vision usage metering remain launch work; until then, cart-value escalation can only activate once a trusted cart writer is added.
- A formal data-retention schedule and automated deletion jobs are required for messages, webhook/queue dedupe rows, and inbound media.
- Public legal pages, Facebook's deletion callback/instructions, seller account deletion,
  and cross-tenant Page reclaim are not implemented by this repository's current routes.
- End-to-end staging tests must cover real Meta and SSLCommerz sandboxes, Queue redelivery/dead letters, Durable Object eviction, and cross-tenant isolation.

Do not turn on a feature flag merely because the Worker bundles. The associated credential, policy approval, reconciliation path, alert, and rollback procedure must all be ready.
