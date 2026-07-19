# Facebook seller login and Page approval

InboxPlease uses two separate Facebook consent steps. Signing in identifies the
seller and creates or loads their workspace. It does not authorize Messenger
automation. A signed-in owner or admin must then authorize Page permissions,
choose an eligible Page, and explicitly enable AI messaging for that Page.

## Meta app configuration

Use two Meta apps because Meta's login-only app type does not expose Page or
Messenger permissions:

1. A Facebook Login app identifies sellers for Auth.js. Configure this exact
   redirect URI:

```text
https://api.example.com/authjs/callback/facebook
```

2. A separate app created with the **Engage with customers on Messenger from
   Meta** use case authorizes Pages and signs webhook deliveries. Enable
   `pages_show_list`, `pages_manage_metadata`, and `pages_messaging`, then
   configure this exact redirect URI:

```text
https://api.example.com/facebook/callback
```

Configure the Page webhook callback separately:

```text
https://api.example.com/webhooks/meta
```

Use the same value as the Worker secret `META_VERIFY_TOKEN` when Meta verifies
that webhook. Subscribe the app to the Page messaging fields used by the
Worker. The onboarding endpoint also subscribes each seller-approved Page to
the app before it can be marked ready.

The initial login requests only `public_profile`; Facebook email is not required. The
later Page connection requests only `pages_show_list`, `pages_manage_metadata`, and
`pages_messaging`, then lists Pages the seller already manages. Because Facebook IDs are
app-scoped, the two apps return different IDs for the same person. The callback instead
requires the same active InboxPlease user and merchant session that created its hashed,
one-time state. Page selection and InboxPlease AI approval remain separate and mandatory.
External sellers will not be able to complete the flow until the app has the
appropriate Advanced Access/App Review approval and is available to those
accounts. The authorizing Facebook account must have the Page messaging task.
Before App Review, complete the public Privacy Policy, Terms, user-data deletion,
seller deletion, and Page reclaim requirements in the
[Meta production compliance checklist](meta-production-compliance.md).

## Worker configuration

Keep secrets out of `wrangler.jsonc`, dashboard `VITE_*` variables, URLs, and
logs. Configure them with `wrangler secret put`:

```text
AUTH_SECRET
AUTH_FACEBOOK_SECRET
META_APP_SECRET
META_VERIFY_TOKEN
META_TOKEN_ENCRYPTION_KEY
```

`META_TOKEN_ENCRYPTION_KEY` must be a base64-encoded 32-byte AES key. Set the
login app's public numeric ID as `AUTH_FACEBOOK_ID`, and set the Messenger app's
public numeric ID as `META_APP_ID`. Set `PUBLIC_API_BASE_URL` to the exact canonical
API origin, omit `AUTH_URL` because `/authjs` is explicitly configured, and set
`DASHBOARD_ORIGIN` to the exact dashboard origin. If `META_APP_ID` and
`META_APP_SECRET` are both omitted, the Worker supports a legacy single-app setup by
falling back to the login app; that fallback cannot make unsupported permissions valid
for a login-only Meta app.

The dashboard and API must use HTTPS origins on the same registrable custom
domain (for example, `app.example.com` and `api.example.com`), or a single
proxied origin. Provider subdomains such as separate `pages.dev` and
`workers.dev` sites are cross-site and cannot carry the default Auth.js
SameSite session cookie reliably.

For the normal seller experience, keep:

```text
AUTH_PASSWORD_FALLBACK_ENABLED=false
```

`AI_ENABLED` and `MESSAGING_ENABLED` are platform kill switches. A seller's
Page approval cannot override either switch. Keep both off until the Meta app,
webhook, token encryption, model access, and end-to-end delivery test are all
ready.

## Local development

Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` and fill the local
values. Register each local callback in its corresponding development app:

```text
http://localhost:8787/authjs/callback/facebook
http://localhost:8787/facebook/callback
```

Then run:

```powershell
npm.cmd run db:migrate:local --workspace @inboxplease/api
npm.cmd run dev:api
npm.cmd run dev:dashboard
```

The dashboard runs at `http://localhost:5173` and proxies `/api` and
`/authjs` to the Worker. If the Meta app will not accept a localhost callback,
use stable HTTPS development origins and update all three origin settings and
both redirect URIs together.

## Activation invariants

A Page can send an AI reply only when all of these are true:

- the Page token is stored as an authenticated encrypted envelope;
- all required Page permissions and the messaging task were returned;
- the Page webhook subscription succeeded;
- an owner or admin explicitly approved and enabled AI messaging;
- the Page has not been disconnected; and
- both platform kill switches are enabled.

Turning AI off stops new generation and outbound delivery without requiring
the Page to be disconnected. Disconnecting first disables local sends, then
attempts to remove the Facebook app subscription, and retains the encrypted
token until repeated subscription-state reconciliation confirms the unsubscribe.
The one-minute Worker cron reasserts the seller's latest desired state with
leased, bounded retries; permanent credential failures stop retrying and remain
visible for an explicit reconnect.

Messenger policy still applies after technical activation. AI replies use the
normal response path; do not treat Page access as permission for unrestricted
proactive messaging outside Meta's allowed window and message categories.
