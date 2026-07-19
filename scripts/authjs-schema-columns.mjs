/** Complete stage-9 column contract required by the installed Auth.js D1 adapter. */
export const AUTHJS_REQUIRED_COLUMNS = Object.freeze({
  users: Object.freeze([
    'id', 'name', 'email', 'emailVerified', 'image',
    'email_normalized', 'password_hash', 'password_salt',
    'password_iterations', 'status', 'created_at', 'updated_at',
  ]),
  accounts: Object.freeze([
    'id', 'userId', 'type', 'provider', 'providerAccountId',
    'refresh_token', 'access_token', 'expires_at', 'token_type', 'scope',
    'id_token', 'session_state', 'oauth_token_secret', 'oauth_token',
  ]),
  sessions: Object.freeze(['id', 'sessionToken', 'userId', 'expires']),
  verification_tokens: Object.freeze(['identifier', 'token', 'expires']),
});
