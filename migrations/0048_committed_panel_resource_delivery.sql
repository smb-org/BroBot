-- The D1 triggers in 0047 already advance resource revisions with the write
-- transaction. Keep a durable per-channel publication queue beside them so
-- notifiers only visit channels with committed, unpublished panel changes.
CREATE TABLE panel_resource_pending (
  channel_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (channel_id, resource)
);

CREATE INDEX panel_resource_pending_channel_idx ON panel_resource_pending(channel_id);

CREATE TRIGGER panel_resource_pending_insert AFTER INSERT ON panel_resource_revisions BEGIN
  INSERT INTO panel_resource_pending (channel_id, resource, revision)
  VALUES (NEW.channel_id, NEW.resource, NEW.revision)
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = MAX(revision, excluded.revision);
END;

CREATE TRIGGER panel_resource_pending_update AFTER UPDATE ON panel_resource_revisions BEGIN
  INSERT INTO panel_resource_pending (channel_id, resource, revision)
  VALUES (NEW.channel_id, NEW.resource, NEW.revision)
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = MAX(revision, excluded.revision);
END;

-- A global channel-list revision is expanded to channel-local work only when
-- a write actually changes that shared list. The notifier drains these rows
-- instead of enumerating the installation on every request.
CREATE TRIGGER panel_rev_global_channels_update
AFTER UPDATE OF revision ON panel_global_resource_revisions
WHEN NEW.resource = 'channels' AND NEW.revision > OLD.revision BEGIN
  INSERT INTO panel_resource_revisions (channel_id, resource, revision)
  SELECT channel_id, 'channels', 1 FROM channels WHERE 1
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- A channel delete cascades through its source rows. Their dependency triggers
-- may enqueue revisions during that cascade, so clean the deleted channel's
-- revision and outbox rows after the cascaded writes finish.
DROP TRIGGER panel_rev_channels_delete;
CREATE TRIGGER panel_rev_channels_delete AFTER DELETE ON channels BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
  DELETE FROM panel_resource_revisions WHERE channel_id = OLD.channel_id;
  DELETE FROM panel_resource_pending WHERE channel_id = OLD.channel_id;
END;

UPDATE panel_global_resource_revisions
   SET revision = revision + 1
 WHERE resource = 'channels';

-- Existing cache hashes cannot be reversed to recover their owning channel.
-- New API-cache writes store that owner explicitly; old cache rows expire in
-- at most the existing five-minute cache window and need no synthetic fanout.
ALTER TABLE api_source_cache ADD COLUMN channel_id TEXT REFERENCES channels(channel_id) ON DELETE CASCADE;

DELETE FROM panel_resource_dependencies WHERE source_table IN ('api_source_cache', 'weather_cache');
INSERT OR IGNORE INTO panel_resource_dependencies (source_table, resource) VALUES
  ('api_source_cache', 'channel.library'),
  ('weather_cache', 'channel.library');

DELETE FROM panel_resource_dependencies WHERE source_table = 'channels' AND resource = 'channel.library';
INSERT INTO panel_resource_dependencies (source_table, resource) VALUES ('channels', 'channel.library');

INSERT OR IGNORE INTO panel_resource_dependencies (source_table, resource) VALUES
  ('channel_modules', 'channel.system'),
  ('channel_modules', 'channel.library'),
  ('channel_modules', 'module:*:data'),
  ('bot_identity', 'channel.overview'),
  ('bot_identity', 'channel.system'),
  ('bot_identity', 'channel.modules'),
  ('bot_identity', 'module:*:settings'),
  ('bot_identity_status', 'channel.overview'),
  ('bot_identity_status', 'channel.system'),
  ('bot_identity_status', 'channel.modules'),
  ('bot_identity_status', 'module:*:settings'),
  ('twitch_login_identity', 'channel.members'),
  ('twitch_login_identity', 'channel.audit'),
  ('twitch_login_identity', 'channel.modules'),
  ('twitch_login_identity', 'module:*:settings'),
  ('twitch_login_identity', 'module:ads:schedule');

-- Keep the legacy global cache counters and publication table through the
-- migration-before-code rollout window. Workers already serving traffic may
-- still read and update them; a later migration can remove them after rollout.

DROP TRIGGER panel_rev_modules_insert;
DROP TRIGGER panel_rev_modules_update;
DROP TRIGGER panel_rev_modules_delete;
CREATE TRIGGER panel_rev_modules_insert AFTER INSERT ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource IN ('module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_modules_update AFTER UPDATE ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource IN ('module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_modules_delete AFTER DELETE ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, replace(resource, '*', OLD.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource IN ('module:*:settings', 'module:*:data') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

-- Bot identity is global. Its committed row changes affect every channel's
-- connection, module permission and channel-list state, so revisions are
-- expanded here in the same D1 transaction.
DROP TRIGGER panel_rev_bot_identity_insert;
DROP TRIGGER panel_rev_bot_identity_update;
DROP TRIGGER panel_rev_bot_identity_delete;
DROP TRIGGER panel_rev_bot_identity_status_insert;
DROP TRIGGER panel_rev_bot_identity_status_update;
DROP TRIGGER panel_rev_bot_identity_status_delete;
CREATE TRIGGER panel_rev_bot_identity_insert AFTER INSERT ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_update AFTER UPDATE ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_delete AFTER DELETE ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_insert AFTER INSERT ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity_status' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity_status' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_update AFTER UPDATE ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity_status' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity_status' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_delete AFTER DELETE ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity_status' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity_status' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

-- A login identity updates the member row in every current channel, the owner
-- channel's permission-dependent module settings and ads query, and audit
-- filters that still contain the actor after membership removal.
DROP TRIGGER panel_rev_login_identity_insert;
DROP TRIGGER panel_rev_login_identity_update;
DROP TRIGGER panel_rev_login_identity_delete;
CREATE TRIGGER panel_rev_login_identity_insert AFTER INSERT ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id WHERE (channel.channel_id = NEW.user_id OR member.user_id = NEW.user_id) AND dependency.resource NOT IN ('channels', 'channel.modules', 'module:*:settings', 'module:ads:schedule') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, dependency.resource, 1 FROM panel_resource_dependencies AS dependency WHERE dependency.source_table = 'twitch_login_identity' AND dependency.resource IN ('channel.modules', 'module:ads:schedule') AND EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.user_id) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, 'module:' || module.module_id || ':settings', 1 FROM channel_modules AS module WHERE module.channel_id = NEW.user_id AND EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_login_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT DISTINCT audit.channel_id, 'channel.audit', 1 FROM audit_log AS audit WHERE audit.actor_user_id = NEW.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_login_identity_update AFTER UPDATE ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id WHERE (channel.channel_id = NEW.user_id OR member.user_id = NEW.user_id) AND dependency.resource NOT IN ('channels', 'channel.modules', 'module:*:settings', 'module:ads:schedule') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, dependency.resource, 1 FROM panel_resource_dependencies AS dependency WHERE dependency.source_table = 'twitch_login_identity' AND dependency.resource IN ('channel.modules', 'module:ads:schedule') AND EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.user_id) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, 'module:' || module.module_id || ':settings', 1 FROM channel_modules AS module WHERE module.channel_id = NEW.user_id AND EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_login_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT DISTINCT audit.channel_id, 'channel.audit', 1 FROM audit_log AS audit WHERE audit.actor_user_id = NEW.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_login_identity_delete AFTER DELETE ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id WHERE (channel.channel_id = OLD.user_id OR member.user_id = OLD.user_id) AND dependency.resource NOT IN ('channels', 'channel.modules', 'module:*:settings', 'module:ads:schedule') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.user_id, dependency.resource, 1 FROM panel_resource_dependencies AS dependency WHERE dependency.source_table = 'twitch_login_identity' AND dependency.resource IN ('channel.modules', 'module:ads:schedule') AND EXISTS (SELECT 1 FROM channels WHERE channel_id = OLD.user_id) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.user_id, 'module:' || module.module_id || ':settings', 1 FROM channel_modules AS module WHERE module.channel_id = OLD.user_id AND EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_login_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT DISTINCT audit.channel_id, 'channel.audit', 1 FROM audit_log AS audit WHERE audit.actor_user_id = OLD.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

DROP TRIGGER panel_rev_api_source_cache_insert;
DROP TRIGGER panel_rev_api_source_cache_update;
DROP TRIGGER panel_rev_api_source_cache_delete;
CREATE TRIGGER panel_rev_api_source_cache_insert AFTER INSERT ON api_source_cache BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_source_cache' AND NEW.channel_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  -- Old workers do not store cache ownership. Fan out the library revision so
  -- new clients can recover a missed hint after those writes are committed.
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.library', 1 FROM channels WHERE NEW.channel_id IS NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache' AND NEW.channel_id IS NULL;
END;
CREATE TRIGGER panel_rev_api_source_cache_update AFTER UPDATE ON api_source_cache BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_source_cache' AND NEW.channel_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.library', 1 FROM channels WHERE NEW.channel_id IS NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache' AND (OLD.channel_id IS NULL OR NEW.channel_id IS NULL);
END;
CREATE TRIGGER panel_rev_api_source_cache_delete AFTER DELETE ON api_source_cache BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_source_cache' AND OLD.channel_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.library', 1 FROM channels WHERE OLD.channel_id IS NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache' AND OLD.channel_id IS NULL;
END;

DROP TRIGGER panel_rev_weather_cache_insert;
DROP TRIGGER panel_rev_weather_cache_update;
DROP TRIGGER panel_rev_weather_cache_delete;
CREATE TRIGGER panel_rev_weather_cache_insert AFTER INSERT ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
  INSERT INTO panel_resource_revisions
  SELECT channel.channel_id, dependency.resource, 1
    FROM channels AS channel
    LEFT JOIN weather_settings AS setting ON setting.channel_id = channel.channel_id
    JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'weather_cache'
   WHERE channel.location_latitude IS NOT NULL
     AND channel.location_longitude IS NOT NULL
     AND round(channel.location_latitude, 4) = NEW.latitude
     AND round(channel.location_longitude, 4) = NEW.longitude
     AND COALESCE(setting.provider, 'met_norway') = NEW.provider
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_weather_cache_update AFTER UPDATE ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
  INSERT INTO panel_resource_revisions
  SELECT channel.channel_id, dependency.resource, 1
    FROM channels AS channel
    LEFT JOIN weather_settings AS setting ON setting.channel_id = channel.channel_id
    JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'weather_cache'
   WHERE channel.location_latitude IS NOT NULL
     AND channel.location_longitude IS NOT NULL
     AND round(channel.location_latitude, 4) = NEW.latitude
     AND round(channel.location_longitude, 4) = NEW.longitude
     AND COALESCE(setting.provider, 'met_norway') = NEW.provider
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT channel.channel_id, dependency.resource, 1
    FROM channels AS channel
    LEFT JOIN weather_settings AS setting ON setting.channel_id = channel.channel_id
    JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'weather_cache'
   WHERE channel.location_latitude IS NOT NULL
     AND channel.location_longitude IS NOT NULL
     AND round(channel.location_latitude, 4) = OLD.latitude
     AND round(channel.location_longitude, 4) = OLD.longitude
     AND COALESCE(setting.provider, 'met_norway') = OLD.provider
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_weather_cache_delete AFTER DELETE ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
  INSERT INTO panel_resource_revisions
  SELECT channel.channel_id, dependency.resource, 1
    FROM channels AS channel
    LEFT JOIN weather_settings AS setting ON setting.channel_id = channel.channel_id
    JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'weather_cache'
   WHERE channel.location_latitude IS NOT NULL
     AND channel.location_longitude IS NOT NULL
     AND round(channel.location_latitude, 4) = OLD.latitude
     AND round(channel.location_longitude, 4) = OLD.longitude
     AND COALESCE(setting.provider, 'met_norway') = OLD.provider
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Deliver pre-migration revisions once; reconnect and focus checks remain the
-- fallback if publication fails after the durable revision commit.
INSERT INTO panel_resource_pending (channel_id, resource, revision)
SELECT channel_id, resource, revision FROM panel_resource_revisions
WHERE 1
ON CONFLICT(channel_id, resource) DO UPDATE SET revision = MAX(revision, excluded.revision);
