-- Schema-Baseline. Erzeugt aus den 23 Einzelmigrationen, die bis
-- 0022_token_scopes.sql liefen; sie sind damit abgeloest.
--
-- Diese Datei ist die einzige Wahrheit ueber Tabellen-, Spalten- und
-- Constraint-Namen. Sie wurde mit `node scripts/d1-baseline.mjs` erzeugt und
-- danach nur umgebrochen -- `tests/unit/sql-contract.test.ts` prueft jede
-- Abfrage des Projekts gegen sie, `tests/unit/schema-baseline.test.ts` haelt
-- `LATEST_SCHEMA_MIGRATION` an ihrem Dateinamen.

CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  module_id TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'mitglied'
  CHECK (actor_kind IN ('mitglied', 'betreiber')),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX audit_log_actor_kind_created_idx ON audit_log(actor_kind, created_at);

CREATE INDEX audit_log_channel_created_idx ON audit_log(channel_id, created_at);

CREATE INDEX audit_log_channel_module_created_idx
  ON audit_log(channel_id, module_id, created_at);

CREATE TABLE auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT
);

CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE bot_channel_status (
  channel_id TEXT PRIMARY KEY,
  is_moderator INTEGER NOT NULL CHECK (is_moderator IN (0, 1)),
  checked_at TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX bot_channel_status_moderator_idx ON bot_channel_status(is_moderator);

CREATE TABLE bot_channel_status_check_locks (
  channel_id TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE bot_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
,
  missing_scopes_json TEXT);

CREATE TABLE bot_identity_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE "channel_members" (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('broadcaster', 'verwalter', 'bediener')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX channel_members_channel_idx ON channel_members(channel_id);

CREATE INDEX channel_members_channel_role_idx ON channel_members(channel_id, role);

CREATE TABLE channel_modules (
  channel_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  settings TEXT NOT NULL DEFAULT '{}',
  UNIQUE (channel_id, module_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX channel_modules_channel_idx ON channel_modules(channel_id);

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
,
  language TEXT NOT NULL DEFAULT 'de'
  CHECK (language IN ('de', 'en')),
  vollzustimmung INTEGER NOT NULL DEFAULT 0
  CHECK (vollzustimmung IN (0, 1)));

CREATE TABLE event_log (
  event_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  module_id TEXT NOT NULL,
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  -- Null, wenn das Ereignis nicht von einer Person ausgelöst wurde
  -- (Zeitgeber, EventSub-Nachricht ohne Absender).
  actor_user_id TEXT,
  trigger_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX event_log_channel_created_idx ON event_log(channel_id, created_at);

CREATE INDEX event_log_channel_trigger_idx ON event_log(channel_id, trigger_id);

CREATE INDEX event_log_created_at_idx ON event_log(created_at);

CREATE TABLE eventsub_messages (
  message_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE INDEX eventsub_messages_received_idx ON eventsub_messages(received_at);

CREATE TABLE eventsub_revocations (
  subscription_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  revoked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX eventsub_revocations_channel_idx
  ON eventsub_revocations(channel_id, revoked_at);

CREATE TABLE "eventsub_subscriptions" (
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1',
  subscription_id TEXT,
  secret_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'missing', 'error', 'revoked')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  error_message TEXT,
  error_status INTEGER,
  PRIMARY KEY (channel_id, subscription_type, variant, version),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX eventsub_subscriptions_channel_idx
  ON eventsub_subscriptions(channel_id, updated_at);

CREATE INDEX eventsub_subscriptions_id_idx
  ON eventsub_subscriptions(subscription_id);

CREATE TABLE oauth_transactions (
  transaction_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'bot')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  failure_reason TEXT
,
  redirect_path TEXT,
  expected_user_id TEXT);

CREATE INDEX oauth_transactions_expiry_idx ON oauth_transactions(expires_at);

CREATE INDEX oauth_transactions_used_idx ON oauth_transactions(used_at);

CREATE TABLE overlay_tokens (
  token_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  last_used_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX overlay_tokens_channel_idx ON overlay_tokens(channel_id);

CREATE TABLE textbefehle_commands (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  response_text TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  art TEXT NOT NULL DEFAULT 'text' CHECK (art IN ('text', 'liste')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  minimum_level TEXT NOT NULL DEFAULT 'alle'
  CHECK (minimum_level IN ('alle', 'abonnent', 'vip', 'moderator', 'broadcaster')),
  PRIMARY KEY (channel_id, command_name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  CHECK (art = 'liste' OR length(trim(response_text)) > 0)
);

CREATE INDEX textbefehle_commands_channel_idx
  ON textbefehle_commands(channel_id, command_name);

CREATE TABLE twitch_app_access_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE twitch_connections (
  connection_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('broadcaster', 'bot')),
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, purpose),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX twitch_connections_channel_idx ON twitch_connections(channel_id);

CREATE INDEX twitch_connections_expiry_idx ON twitch_connections(channel_id, expires_at);

CREATE TABLE twitch_login_identity (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
,
  token_scopes_json TEXT NOT NULL DEFAULT '[]');

CREATE INDEX twitch_login_identity_status_idx ON twitch_login_identity(status);
