-- Auth.js' D1 adapter uses a fixed `users` table. Rebuild the existing
-- first-party table as a compatible superset so password identities keep the
-- same IDs and merchant memberships while Auth.js can use its standard SQL.
PRAGMA defer_foreign_keys = ON;

DROP INDEX idx_memberships_merchant_role;
ALTER TABLE merchant_memberships RENAME TO merchant_memberships_0008;
ALTER TABLE users RENAME TO users_0008;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT COLLATE NOCASE UNIQUE,
  emailVerified TEXT,
  image TEXT,
  email_normalized TEXT COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER CHECK (
    password_iterations IS NULL OR password_iterations >= 100000
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (password_hash IS NULL AND password_salt IS NULL AND password_iterations IS NULL)
    OR
    (password_hash IS NOT NULL AND password_salt IS NOT NULL
      AND password_iterations IS NOT NULL AND email_normalized IS NOT NULL)
  )
);

INSERT INTO users (
  id, name, email, emailVerified, image, email_normalized,
  password_hash, password_salt, password_iterations,
  status, created_at, updated_at
)
SELECT
  id, name, email_normalized, NULL, NULL, email_normalized,
  password_hash, password_salt, password_iterations,
  status, created_at, updated_at
FROM users_0008;

CREATE TABLE merchant_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'service')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, merchant_id)
);

INSERT INTO merchant_memberships (
  user_id, merchant_id, role, status, created_at, updated_at
)
SELECT user_id, merchant_id, role, status, created_at, updated_at
FROM merchant_memberships_0008;

DROP TABLE merchant_memberships_0008;
DROP TABLE users_0008;

CREATE INDEX idx_memberships_merchant_role
  ON merchant_memberships(merchant_id, status, role);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  providerAccountId TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  oauth_token_secret TEXT,
  oauth_token TEXT,
  UNIQUE (provider, providerAccountId)
);
CREATE INDEX idx_authjs_accounts_user ON accounts(userId);

CREATE TABLE sessions (
  id TEXT NOT NULL UNIQUE,
  sessionToken TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires TEXT NOT NULL
);
CREATE INDEX idx_authjs_sessions_user ON sessions(userId);

CREATE TABLE verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT PRIMARY KEY,
  expires TEXT NOT NULL
);
CREATE INDEX idx_authjs_verification_identifier
  ON verification_tokens(identifier);

-- The adapter writes `email` while first-party password lookup uses
-- `email_normalized`. Keep both ASCII-case-insensitively canonical without
-- requiring adapter patches. Password signup performs Unicode NFKC in code.
CREATE TRIGGER users_normalize_adapter_email_insert
AFTER INSERT ON users
WHEN NEW.email IS NOT NULL AND (
  NEW.email_normalized IS NULL
  OR NEW.email COLLATE BINARY <> lower(trim(NEW.email)) COLLATE BINARY
  OR NEW.email_normalized COLLATE BINARY <> lower(trim(NEW.email)) COLLATE BINARY
)
BEGIN
  UPDATE users
  SET email = lower(trim(NEW.email)),
      email_normalized = lower(trim(NEW.email)),
      updated_at = unixepoch()
  WHERE id = NEW.id;
END;

CREATE TRIGGER users_normalize_adapter_email_update
AFTER UPDATE OF email ON users
WHEN
  (NEW.email IS NULL AND NEW.email_normalized IS NOT NULL)
  OR
  (NEW.email IS NOT NULL AND (
    NEW.email_normalized IS NULL
    OR NEW.email COLLATE BINARY <> lower(trim(NEW.email)) COLLATE BINARY
    OR NEW.email_normalized COLLATE BINARY <> lower(trim(NEW.email)) COLLATE BINARY
  ))
BEGIN
  UPDATE users
  SET email = CASE WHEN NEW.email IS NULL THEN NULL ELSE lower(trim(NEW.email)) END,
      email_normalized = CASE
        WHEN NEW.email IS NULL THEN NULL ELSE lower(trim(NEW.email))
      END,
      updated_at = unixepoch()
  WHERE id = NEW.id;
END;
