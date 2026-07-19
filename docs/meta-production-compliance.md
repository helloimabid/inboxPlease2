# Meta production compliance and deletion policy

This checklist is a production launch gate for InboxPlease's Facebook login and
Messenger integration. It describes the policy and lifecycle that the product must
implement; it is not a claim that legal pages or deletion endpoints already exist.
Meta can change App Review fields and requirements, so recheck the App Dashboard and
the [Meta Platform Terms](https://developers.facebook.com/terms/) before every
submission.

## Public Privacy Policy and Terms

Publish stable, public HTTPS pages for both the Privacy Policy and Terms of Service.
They must not require a login, return a placeholder, or redirect to a generic home
page. Link both pages from signup/signin and the dashboard footer, and enter the exact
URLs in the Meta App Dashboard.

The Privacy Policy must accurately cover at least:

- the legal operator and a monitored privacy contact;
- Facebook identity data, Page IDs and metadata, permissions/tasks, encrypted Page
  tokens, customer messages/media, catalog/order data, and security/audit logs;
- why each category is processed, which processors (including Cloudflare and AI
  providers) receive it, and whether data crosses jurisdictions;
- retention periods or objective retention criteria, backup expiry, and how consent
  can be withdrawn; and
- access, correction, export, objection, and deletion request procedures applicable
  to the seller's location.

The Terms must describe account eligibility, the seller's authority to connect a Page,
acceptable Messenger and AI use, responsibility for customer notices and consent,
plans/payments, suspension and termination, warranty/liability terms, governing law,
and a support contact. The deployment owner should have both documents reviewed for
the jurisdictions being served; do not copy another application's policy.

## Facebook user-data deletion

Before switching the Meta app to live mode, configure the App Dashboard's current
user-data deletion field with either a public instructions URL or an implemented
callback, as allowed by Meta's
[data deletion documentation](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback)
at submission time. A callback is preferable for an account product because it
produces a trackable, idempotent request.

For a callback such as `<PUBLIC_API_BASE_URL>/facebook/data-deletion`:

1. Accept Meta's server POST and verify the `signed_request` with the same canonical
   Messenger app secret used by InboxPlease. Reject invalid signatures before reading
   or changing account data.
2. Resolve the app-scoped Facebook user ID from the verified payload. Never accept an
   unverified user ID, merchant ID, or email from the caller.
3. Create one idempotent deletion job and immediately return the response shape Meta
   currently requires: a public status `url` and an unpredictable
   `confirmation_code`. The status page must reveal only request state.
4. Process deletion asynchronously, record completion or a safe failure code, and
   make retries unable to delete a different tenant.
5. Test invalid signatures, replayed requests, already-deleted users, multiple
   merchant memberships, and status-code guessing before App Review.

If an instructions URL is used instead, it must state the exact in-product and support
steps, identity-verification method, expected timeframe, what is deleted, and what is
retained for a legal obligation. A support inbox alone is not a lifecycle. InboxPlease
currently has neither a public deletion callback nor a complete account-deletion job,
so this remains a launch blocker.

## Seller and workspace deletion lifecycle

Account deletion must be distinct from simply signing out or disconnecting a Page.
Implement one auditable, retry-safe workflow with this ordering:

1. Revoke active sessions, stop new onboarding, and fail closed all AI generation and
   outbound delivery for the affected user/workspace.
2. If other owners remain, remove only the requesting seller's memberships and
   Facebook identity. If the requester is the sole owner, require an ownership transfer
   or explicit whole-workspace deletion; never leave an ownerless merchant.
3. For whole-workspace deletion, set every Page's desired subscription to disconnected
   and allow bounded reconciliation to confirm the Meta unsubscribe. Keep a Page token
   encrypted only while it is needed for that unsubscribe, then erase it.
4. Delete or irreversibly anonymize Auth.js accounts/sessions/users, memberships,
   onboarding sessions/candidates, Page credentials, messages and media, AI/vector
   artifacts, Durable Object state, R2 objects, and queued/retry copies within the
   published retention window.
5. Retain only records required by law or fraud/security obligations, minimize and
   isolate them, document the reason and expiry in the Privacy Policy, and prevent
   retained records from being used for messaging or AI.
6. Expire the status page after the published verification period while preserving a
   non-personal audit record of completion.

The migration trigger that disables Page AI when a user is deleted is only a safety
backstop. It does not implement this lifecycle or prove erasure from secondary stores.

## Disconnected Page ownership and reclaim

Disconnect is reversible and is not account or workspace deletion. The current model
keeps the Page ID claimed by its original merchant, blocks a different merchant with
`FACEBOOK_PAGE_ALREADY_CONNECTED`, and permits the original merchant to reconnect
through fresh Page consent. After repeated unsubscribe confirmations, the encrypted
Page token is erased; the Page row and merchant-scoped history remain subject to the
published retention policy.

Do not transfer a disconnected Page merely because its token is null. A future
cross-tenant reclaim workflow must require fresh Facebook consent proving the requester
has the Page messaging task and either approval from an existing owner of the old
workspace or a completed old-workspace deletion. It must unsubscribe the old
connection, destroy the old credential, keep old tenant data isolated, atomically move
or recreate the claim without reusing history, and emit an operator audit event.
Until that workflow and its dispute procedure exist, support must not reassign Page IDs
with direct D1 edits; disputed cross-tenant claims remain blocked.

## App Review evidence

The initial login uses only `public_profile`; Page onboarding requests
`pages_show_list`, `pages_manage_metadata`, and `pages_messaging`. For each reviewed Page permission,
provide a plain-language purpose, exact reviewer steps, a working review account/Page,
and a recording that shows Page selection, the unchecked AI approval, an inbound test
message, the generated response, pause, and disconnect. Confirm the reviewer can
exercise the flow without production customer data and that the Privacy Policy, Terms,
and deletion path all work before submitting.

## Canonical production origins

Production auth must have one API origin on a Cloudflare
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
The dashboard and API must be HTTPS hosts on the same registrable domain. For example:

```jsonc
{
  "workers_dev": false,
  "routes": [
    { "pattern": "api.example.com", "custom_domain": true }
  ],
  "vars": {
    "PUBLIC_API_BASE_URL": "https://api.example.com",
    "DASHBOARD_ORIGIN": "https://app.example.com"
  }
}
```

The custom-domain route pattern must match the `PUBLIC_API_BASE_URL` hostname exactly.
Keep `AUTH_URL` unset because the application declares `/authjs` explicitly. Register the resulting exact Facebook
callbacks:

```text
https://api.example.com/authjs/callback/facebook
https://api.example.com/facebook/callback
```

Set `workers_dev=false` so the Worker does not expose a second production auth origin.
The checked-in Wrangler file intentionally still has local/example values,
`workers_dev=true`, and no custom route; the production validator and deploy command
must continue to reject it until the real domains are chosen and configured.
