CREATE TABLE event_log_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  module_id TEXT NOT NULL,
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  -- Null when the event wasn't triggered by a person (a timer, an
  -- EventSub message without a sender).
  actor_user_id TEXT,
  trigger_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO event_log_new (seq, event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id)
SELECT rowid, event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id
  FROM event_log
 ORDER BY rowid;

DROP TABLE event_log;
ALTER TABLE event_log_new RENAME TO event_log;

CREATE INDEX event_log_channel_created_idx ON event_log(channel_id, created_at);
CREATE INDEX event_log_channel_trigger_idx ON event_log(channel_id, trigger_id);
CREATE INDEX event_log_created_at_idx ON event_log(created_at);
CREATE INDEX event_log_recent_ads_idx ON event_log(channel_id, created_at DESC, event_id DESC)
  WHERE module_id = 'ads' AND code = 'ads.announcement';
CREATE INDEX event_log_channel_seq_idx ON event_log(channel_id, seq);

CREATE TRIGGER panel_rev_events_insert AFTER INSERT ON event_log BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource NOT LIKE 'module:%*%' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource = 'module:*:data' AND NEW.module_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, 'module:ads:schedule', 1 WHERE NEW.module_id = 'ads' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_events_update AFTER UPDATE ON event_log BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource NOT LIKE 'module:%*%' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource = 'module:*:data' AND NEW.module_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, 'module:ads:schedule', 1 WHERE NEW.module_id = 'ads' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_events_delete AFTER DELETE ON event_log
WHEN NOT EXISTS (
  SELECT 1 FROM panel_event_log_retention_resources
   WHERE channel_id = OLD.channel_id
)
BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource NOT LIKE 'module:%*%' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, replace(resource, '*', OLD.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource = 'module:*:data' AND OLD.module_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, 'module:ads:schedule', 1 WHERE OLD.module_id = 'ads' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
