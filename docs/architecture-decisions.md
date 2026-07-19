# Architecture decisions

## D1 is the MVP system of record

The v2 brief contains older Postgres and Typesense references alongside the final decision to start on D1. This implementation follows the final decision: D1 owns merchants, pages, catalog, orders, usage, and cross-tenant operational data. Search begins with D1 full-text search and indexed filters. A data-access boundary keeps a later Postgres migration possible when size or reporting load justifies it.

## Durable Objects own conversational consistency

`CustomerThreadDO` serializes a page/customer conversation and owns the rolling profile, messages, cart, escalation counters, and handoff state. `StorePageDO` owns page settings and a compact catalog cache. Instance names are composite tenant keys, never raw customer IDs.

These are regular SQLite-backed Durable Objects because Messenger uses HTTP webhooks. The design does not claim WebSocket hibernation savings for fetch-only instances.

## Asynchronous side effects

The request path validates and persists inbound events, then enqueues slow or retryable work. Catalog, settings, order-status, and stock mutations write a Queue job to `outbox_events` in the same D1 batch as the domain change. Eager publication runs under `waitUntil`, and a one-minute scheduled sweep repairs missed publications with a lease and bounded backoff. An outbox row is marked dispatched only after Queue accepts the message. Queue messages reuse the outbox event ID as their idempotency key, so a recovered lease may safely publish twice. Messenger delivery, payment reconciliation, catalog indexing, settings-cache refresh, and order-status fan-out are safe to retry.

Payment-session creation is the deliberate exception: SSLCommerz must synchronously return a checkout URL. The Worker reserves the exact transaction and inserts its pending payment attempt in one D1 batch, initializes the gateway, and returns the URL. Redirects and IPNs never mark an order paid directly; a queued reconciliation validates the transaction server-to-server and applies an idempotent state transition.

## Model routing

The router is deterministic and unit-tested. Qwen3 is the normal path. A complaint, a cart value of at least 500,000 poisha (৳5,000), or two consecutive low-confidence replies selects Claude Haiku through AI Gateway. The model decision and gateway log identifier are recorded for observability without logging customer message bodies by default.

## Search and image matching

Exact text and facet searches query D1. Semantic fallback embeds product text with Qwen3 Embedding (1,024 dimensions) and queries a cosine Vectorize index filtered by `page_id`. Product-image analysis uses Llama 3.2 Vision first and must pass a confidence gate before a product is presented as an exact match.

## Authentication

The Worker owns Facebook OAuth seller login through Auth.js. A first linked Facebook
identity receives a free-plan merchant and owner membership in an idempotent D1 batch;
email is optional, same-email identities are not automatically linked, and every session
is revalidated against the current membership and merchant. Password signin exists only
as an explicit break-glass fallback, and password signup is local-development-only.
Facebook Page authorization remains a separate consent step. Page OAuth tokens must be
AES-GCM encrypted with the configured managed secret key (or stored as opaque secret
references) and are never returned to the browser.

## Feature gates and policy boundaries

Voice, vision, Vectorize fallback, frontier escalation, and proactive out-of-window messages are independent flags. Text replies inside the standard messaging window are the launch-critical path. In particular, the `HUMAN_AGENT` tag is reserved for messages composed by a human and must never be attached to an automated AI reply.

Meta's current Utility Messages availability must be verified for the production Page and country before order updates outside the normal messaging window are enabled. The implementation records notification intent even when policy prevents delivery, so an approval or channel change does not require an order-model rewrite.

AI output is advisory. It cannot directly mutate price, discount, stock, payment, or order state. Any future tool calls must use allowlisted structured inputs and deterministic business-rule validation.

## Capacity migration triggers

D1's 10 GB per-database limit is a hard ceiling, but it is not the only migration trigger. The database's single-threaded execution model means sustained write contention or cross-tenant analytics latency may justify tenant sharding or Postgres before storage approaches 10 GB. Size, queue lag, query latency, and write-conflict metrics are reviewed together.
