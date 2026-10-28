-- Keep the overview's moderator and stream freshness current with one local
-- resource revision. These fields are read by channel.overview (and moderator
-- freshness by channel.system); stream freshness also feeds belabox:live.
-- The global bot heartbeat is read in the overview payload and gets one global
-- revision instead of expanding through the global channel-list trigger.
CREATE TABLE panel_event_log_retention_resources (
  channel_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  PRIMARY KEY (channel_id, resource)
);

INSERT OR IGNORE INTO panel_global_resource_revisions (resource, revision)
VALUES ('bot.identity.status', 1);

INSERT OR IGNORE INTO panel_global_resource_publications (resource, revision)
VALUES ('bot.identity.status', 1);

-- Login scopes and identity state remain visible to every member/owner panel,
-- but lease ownership and `updated_at` are maintenance bookkeeping only.
DROP TRIGGER panel_rev_login_identity_update;
CREATE TRIGGER panel_rev_login_identity_update AFTER UPDATE ON twitch_login_identity
WHEN OLD.user_id IS NOT NEW.user_id
  OR OLD.login IS NOT NEW.login
  OR OLD.scopes_json IS NOT NEW.scopes_json
  OR OLD.token_scopes_json IS NOT NEW.token_scopes_json
  OR OLD.access_token_ciphertext IS NOT NEW.access_token_ciphertext
  OR OLD.refresh_token_ciphertext IS NOT NEW.refresh_token_ciphertext
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.status IS NOT NEW.status
  OR OLD.reason IS NOT NEW.reason
BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id WHERE (channel.channel_id = NEW.user_id OR member.user_id = NEW.user_id) AND dependency.resource NOT IN ('channels', 'channel.modules', 'module:*:settings', 'module:ads:schedule') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, dependency.resource, 1 FROM panel_resource_dependencies AS dependency WHERE dependency.source_table = 'twitch_login_identity' AND dependency.resource IN ('channel.modules', 'module:ads:schedule') AND EXISTS (SELECT 1 FROM channels WHERE channel_id = NEW.user_id) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.user_id, 'module:' || module.module_id || ':settings', 1 FROM channel_modules AS module WHERE module.channel_id = NEW.user_id AND EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_login_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT DISTINCT audit.channel_id, 'channel.audit', 1 FROM audit_log AS audit WHERE audit.actor_user_id = NEW.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

-- `checked_at` is visible on the channel overview and system panel. A newer
-- moderator check refreshes this channel's local data and list entry; changes
-- to the moderator result keep the global fan-out.
DROP TRIGGER panel_rev_bot_status_update;
CREATE TRIGGER panel_rev_bot_status_update AFTER UPDATE ON bot_channel_status
WHEN OLD.is_moderator IS NOT NEW.is_moderator
  OR OLD.reason IS NOT NEW.reason
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'bot_channel_status' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_bot_status_heartbeat_update AFTER UPDATE ON bot_channel_status
WHEN OLD.is_moderator IS NEW.is_moderator
  AND OLD.reason IS NEW.reason
  AND OLD.checked_at IS NOT NEW.checked_at
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'bot_channel_status' AND resource NOT IN ('channels') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions (channel_id, resource, revision) VALUES (NEW.channel_id, 'channels', 1) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- The overview reads stream state and its freshness; the Belabox live panel
-- also depends on stream lifecycle. Heartbeat-only observations advance those
-- local resources and this channel's list entry. State/session transitions
-- still revise the global list.
DROP TRIGGER panel_rev_stream_update;
CREATE TRIGGER panel_rev_stream_update AFTER UPDATE ON channel_stream_state
WHEN OLD.state IS NOT NEW.state
  OR OLD.started_at IS NOT NEW.started_at
  OR OLD.stream_id IS NOT NEW.stream_id
  OR OLD.transition_generation IS NOT NEW.transition_generation
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_stream_state' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_stream_heartbeat_update AFTER UPDATE ON channel_stream_state
WHEN OLD.state IS NEW.state
  AND OLD.started_at IS NEW.started_at
  AND OLD.stream_id IS NEW.stream_id
  AND OLD.transition_generation IS NEW.transition_generation
  AND (OLD.changed_at IS NOT NEW.changed_at OR OLD.checked_at IS NOT NEW.checked_at)
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_stream_state' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions (channel_id, resource, revision) VALUES (NEW.channel_id, 'channels', 1) ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Bot status `updated_at` is a global health heartbeat. Only actual status or
-- reason changes affect every channel's overview and module permissions.
DROP TRIGGER panel_rev_bot_identity_status_update;
CREATE TRIGGER panel_rev_bot_identity_status_update AFTER UPDATE ON bot_identity_status
WHEN OLD.id IS NOT NEW.id
  OR OLD.status IS NOT NEW.status
  OR OLD.reason IS NOT NEW.reason
BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity_status' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity_status' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_bot_identity_status_heartbeat_update AFTER UPDATE ON bot_identity_status
WHEN OLD.id IS NEW.id
  AND OLD.status IS NEW.status
  AND OLD.reason IS NEW.reason
  AND OLD.updated_at IS NOT NEW.updated_at
BEGIN
  UPDATE panel_global_resource_revisions
     SET revision = revision + 1
   WHERE resource = 'bot.identity.status';
END;

-- Usage is shown in the command list, while variables/library dependencies
-- describe the command configuration and must not churn on every execution.
DROP TRIGGER panel_rev_text_commands_update;
CREATE TRIGGER panel_rev_text_commands_update AFTER UPDATE ON text_commands
WHEN OLD.channel_id IS NOT NEW.channel_id
  OR OLD.command_name IS NOT NEW.command_name
  OR OLD.response_text IS NOT NEW.response_text
  OR OLD.cooldown_seconds IS NOT NEW.cooldown_seconds
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.kind IS NOT NEW.kind
  OR OLD.enabled IS NOT NEW.enabled
  OR OLD.minimum_level IS NOT NEW.minimum_level
  OR OLD.aliases_json IS NOT NEW.aliases_json
  OR OLD.user_cooldown_seconds IS NOT NEW.user_cooldown_seconds
  OR OLD.stream_condition IS NOT NEW.stream_condition
  OR OLD.response_type IS NOT NEW.response_type
  OR OLD.template_fields_json IS NOT NEW.template_fields_json
  OR OLD.revision IS NOT NEW.revision
  OR OLD.variable_name IS NOT NEW.variable_name
  OR OLD.variable_operation IS NOT NEW.variable_operation
  OR OLD.variable_amount IS NOT NEW.variable_amount
  OR OLD.games_json IS NOT NEW.games_json
  OR OLD.timeout_min_seconds IS NOT NEW.timeout_min_seconds
  OR OLD.timeout_max_seconds IS NOT NEW.timeout_max_seconds
  OR OLD.timeout_fallback_text IS NOT NEW.timeout_fallback_text
  OR OLD.timeout_reason IS NOT NEW.timeout_reason
  OR OLD.chat_target IS NOT NEW.chat_target
  OR OLD.use_channel_default_target IS NOT NEW.use_channel_default_target
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_commands' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_text_commands_usage_update AFTER UPDATE ON text_commands
WHEN (OLD.last_used_at IS NOT NEW.last_used_at OR OLD.use_count IS NOT NEW.use_count)
  AND OLD.channel_id IS NEW.channel_id
  AND OLD.command_name IS NEW.command_name
  AND OLD.response_text IS NEW.response_text
  AND OLD.cooldown_seconds IS NEW.cooldown_seconds
  AND OLD.created_at IS NEW.created_at
  AND OLD.kind IS NEW.kind
  AND OLD.enabled IS NEW.enabled
  AND OLD.minimum_level IS NEW.minimum_level
  AND OLD.aliases_json IS NEW.aliases_json
  AND OLD.user_cooldown_seconds IS NEW.user_cooldown_seconds
  AND OLD.stream_condition IS NEW.stream_condition
  AND OLD.response_type IS NEW.response_type
  AND OLD.template_fields_json IS NEW.template_fields_json
  AND OLD.revision IS NEW.revision
  AND OLD.variable_name IS NEW.variable_name
  AND OLD.variable_operation IS NEW.variable_operation
  AND OLD.variable_amount IS NEW.variable_amount
  AND OLD.games_json IS NEW.games_json
  AND OLD.timeout_min_seconds IS NEW.timeout_min_seconds
  AND OLD.timeout_max_seconds IS NEW.timeout_max_seconds
  AND OLD.timeout_fallback_text IS NEW.timeout_fallback_text
  AND OLD.timeout_reason IS NEW.timeout_reason
  AND OLD.chat_target IS NEW.chat_target
  AND OLD.use_channel_default_target IS NEW.use_channel_default_target
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1
    FROM panel_resource_dependencies
   WHERE source_table = 'text_commands'
     AND resource = 'module:text_commands:commands'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Text variant selection is runtime bookkeeping. The library resource only
-- depends on the variant's position, conditions, and rendered texts.
DROP TRIGGER panel_rev_text_block_variants_update;
CREATE TRIGGER panel_rev_text_block_variants_update AFTER UPDATE ON text_block_variants
WHEN OLD.channel_id IS NOT NEW.channel_id
  OR OLD.block_name IS NOT NEW.block_name
  OR OLD.variant_id IS NOT NEW.variant_id
  OR OLD.position IS NOT NEW.position
  OR OLD.conditions_json IS NOT NEW.conditions_json
  OR OLD.texts_json IS NOT NEW.texts_json
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Event retention stages the distinct channel/resource pairs before its bulk
-- delete, suppresses per-row trigger work, then advances each pair once in the
-- same D1 batch. Normal event deletes keep the original row-level trigger.
DROP TRIGGER panel_rev_events_delete;
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

DROP TRIGGER panel_rev_belabox_minutes_update;
CREATE TRIGGER panel_rev_belabox_minutes_update AFTER UPDATE ON belabox_minutes
WHEN OLD.channel_id IS NOT NEW.channel_id
  OR OLD.minute_at IS NOT NEW.minute_at
  OR OLD.stream_id IS NOT NEW.stream_id
  OR OLD.samples IS NOT NEW.samples
  OR OLD.connected_samples IS NOT NEW.connected_samples
  OR OLD.bitrate_min IS NOT NEW.bitrate_min
  OR OLD.bitrate_max IS NOT NEW.bitrate_max
  OR OLD.bitrate_sum IS NOT NEW.bitrate_sum
  OR OLD.rtt_max IS NOT NEW.rtt_max
  OR OLD.rtt_sum IS NOT NEW.rtt_sum
  OR OLD.dropped_delta IS NOT NEW.dropped_delta
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_minutes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
