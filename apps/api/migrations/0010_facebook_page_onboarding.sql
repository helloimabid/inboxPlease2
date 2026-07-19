-- Facebook login establishes the seller identity. Page messaging is a
-- separate, explicit authorization and approval workflow.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE store_pages ADD COLUMN meta_subscription_status TEXT NOT NULL
  DEFAULT 'not_subscribed'
  CHECK (meta_subscription_status IN (
    'not_subscribed', 'subscribed', 'subscription_failed',
    'connecting', 'disconnecting', 'unsubscribe_failed', 'disconnected'
  ));
ALTER TABLE store_pages ADD COLUMN meta_permissions_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(meta_permissions_json));
ALTER TABLE store_pages ADD COLUMN meta_tasks_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(meta_tasks_json));
ALTER TABLE store_pages ADD COLUMN messaging_ready_at INTEGER;
ALTER TABLE store_pages ADD COLUMN ai_messaging_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (ai_messaging_enabled IN (0, 1));
ALTER TABLE store_pages ADD COLUMN ai_messaging_approved_at INTEGER;
ALTER TABLE store_pages ADD COLUMN ai_messaging_approved_by_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE store_pages ADD COLUMN ai_messaging_disabled_at INTEGER;
ALTER TABLE store_pages ADD COLUMN disconnected_at INTEGER;
ALTER TABLE store_pages ADD COLUMN meta_last_error TEXT;
ALTER TABLE store_pages ADD COLUMN meta_connection_generation INTEGER NOT NULL DEFAULT 0
  CHECK (meta_connection_generation >= 0);
ALTER TABLE store_pages ADD COLUMN meta_operation_id TEXT;
ALTER TABLE store_pages ADD COLUMN meta_operation_kind TEXT
  CHECK (meta_operation_kind IS NULL OR meta_operation_kind IN ('connect', 'disconnect'));
ALTER TABLE store_pages ADD COLUMN meta_operation_expires_at INTEGER;
ALTER TABLE store_pages ADD COLUMN meta_subscription_desired INTEGER NOT NULL DEFAULT 0
  CHECK (meta_subscription_desired IN (0, 1));
ALTER TABLE store_pages ADD COLUMN meta_reconcile_after INTEGER;
ALTER TABLE store_pages ADD COLUMN meta_reconcile_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (meta_reconcile_attempts >= 0);
ALTER TABLE store_pages ADD COLUMN meta_reconcile_failures INTEGER NOT NULL DEFAULT 0
  CHECK (meta_reconcile_failures >= 0);

CREATE INDEX idx_store_pages_messaging_state
  ON store_pages(merchant_id, ai_messaging_enabled, meta_subscription_status);
CREATE INDEX idx_store_pages_meta_reconcile
  ON store_pages(meta_reconcile_after, meta_operation_expires_at);

CREATE TABLE meta_onboarding_sessions (
  id TEXT PRIMARY KEY,
  state_digest TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  facebook_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'authorization_pending' CHECK (status IN (
    'authorization_pending', 'pages_ready', 'completed',
    'permission_denied', 'no_pages', 'failed'
  )),
  requested_permissions_json TEXT NOT NULL CHECK (json_valid(requested_permissions_json)),
  granted_permissions_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(granted_permissions_json)),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_meta_onboarding_merchant_user
  ON meta_onboarding_sessions(merchant_id, user_id, created_at DESC);
CREATE INDEX idx_meta_onboarding_expiry
  ON meta_onboarding_sessions(expires_at, status);

CREATE TABLE meta_page_candidates (
  session_id TEXT NOT NULL REFERENCES meta_onboarding_sessions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  tasks_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tasks_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, page_id)
);
CREATE INDEX idx_meta_page_candidates_page
  ON meta_page_candidates(page_id, session_id);

-- Current enablement must always be backed by a successful Page subscription,
-- readiness timestamp, and an auditable approval event.
CREATE TRIGGER store_pages_ai_enable_insert
BEFORE INSERT ON store_pages
WHEN NEW.ai_messaging_enabled = 1 AND (
  NEW.meta_subscription_status <> 'subscribed'
  OR NEW.messaging_ready_at IS NULL
  OR NEW.ai_messaging_approved_at IS NULL
  OR NEW.ai_messaging_approved_by_user_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'AI messaging approval is incomplete');
END;

CREATE TRIGGER store_pages_ai_enable_update
BEFORE UPDATE OF ai_messaging_enabled, meta_subscription_status,
  messaging_ready_at, ai_messaging_approved_at, ai_messaging_approved_by_user_id
ON store_pages
WHEN NEW.ai_messaging_enabled = 1 AND (
  NEW.meta_subscription_status <> 'subscribed'
  OR NEW.messaging_ready_at IS NULL
  OR NEW.ai_messaging_approved_at IS NULL
  OR NEW.ai_messaging_approved_by_user_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'AI messaging approval is incomplete');
END;

CREATE TRIGGER store_pages_meta_operation_insert
BEFORE INSERT ON store_pages
WHEN NOT (
  (NEW.meta_operation_id IS NULL AND NEW.meta_operation_kind IS NULL
    AND NEW.meta_operation_expires_at IS NULL)
  OR
  (NEW.meta_operation_id IS NOT NULL AND NEW.meta_operation_kind IS NOT NULL
    AND NEW.meta_operation_expires_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Meta Page operation lease is incomplete');
END;

CREATE TRIGGER store_pages_meta_operation_update
BEFORE UPDATE OF meta_operation_id, meta_operation_kind, meta_operation_expires_at
ON store_pages
WHEN NOT (
  (NEW.meta_operation_id IS NULL AND NEW.meta_operation_kind IS NULL
    AND NEW.meta_operation_expires_at IS NULL)
  OR
  (NEW.meta_operation_id IS NOT NULL AND NEW.meta_operation_kind IS NOT NULL
    AND NEW.meta_operation_expires_at IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Meta Page operation lease is incomplete');
END;

-- Auth.js/account deletion must not be blocked by the approval invariant.
-- Disable affected Pages before the FK clears the approver reference.
CREATE TRIGGER users_disable_page_ai_before_delete
BEFORE DELETE ON users
BEGIN
  UPDATE store_pages
  SET ai_messaging_enabled = 0,
      ai_messaging_disabled_at = unixepoch(),
      updated_at = unixepoch()
  WHERE ai_messaging_approved_by_user_id = OLD.id
    AND ai_messaging_enabled = 1;
END;
