CREATE TABLE channel_members_neu (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('broadcaster', 'verwalter', 'bediener')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO channel_members_neu (channel_id, user_id, role, created_at, updated_at)
SELECT channel_id, user_id, role, created_at, updated_at
  FROM channel_members;

DROP TABLE channel_members;

ALTER TABLE channel_members_neu RENAME TO channel_members;

CREATE INDEX channel_members_channel_idx ON channel_members(channel_id);
CREATE INDEX channel_members_channel_role_idx ON channel_members(channel_id, role);

CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX audit_log_channel_created_idx ON audit_log(channel_id, created_at);
