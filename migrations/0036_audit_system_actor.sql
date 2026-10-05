CREATE TABLE audit_log_rebuilt (
  audit_id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  created_at TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  module_id TEXT,
  actor_kind TEXT NOT NULL DEFAULT 'member'
  CHECK (actor_kind IN ('member', 'platform_admin', 'system')),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO audit_log_rebuilt
  (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json, module_id, actor_kind)
SELECT audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json, module_id, actor_kind
  FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_rebuilt RENAME TO audit_log;

CREATE INDEX audit_log_actor_kind_created_idx ON audit_log(actor_kind, created_at);
CREATE INDEX audit_log_channel_created_idx ON audit_log(channel_id, created_at);
CREATE INDEX audit_log_channel_module_created_idx ON audit_log(channel_id, module_id, created_at);
CREATE INDEX audit_log_channel_actor_created_idx ON audit_log(channel_id, actor_user_id, created_at);
CREATE INDEX audit_log_channel_action_created_idx ON audit_log(channel_id, action, created_at);
