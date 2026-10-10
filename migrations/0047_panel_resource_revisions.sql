-- D1 cannot join a Channel Durable Object storage transaction, so D1 triggers
-- commit their revisions beside each D1 write. DO-only writes advance their
-- own counters in DO transactions; the authenticated vector combines both.
-- Socket publication is a wake-up and is repaired by reconnect/focus reads.
CREATE TABLE panel_resource_revisions (
  channel_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (channel_id, resource)
);

CREATE TABLE panel_global_resource_revisions (
  resource TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);

INSERT INTO panel_global_resource_revisions (resource, revision) VALUES ('channels', 1), ('weather.cache', 1), ('api.cache', 1);

CREATE TABLE panel_global_resource_publications (
  resource TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

INSERT INTO panel_global_resource_publications (resource, revision) VALUES ('channels', 1), ('weather.cache', 1), ('api.cache', 1);

-- This is the dependency map for every D1 table that feeds a dashboard query.
-- Module resources use the stable `module:<id>:<part>` naming convention.
CREATE TABLE panel_resource_dependencies (
  source_table TEXT NOT NULL,
  resource TEXT NOT NULL,
  PRIMARY KEY (source_table, resource)
);

INSERT INTO panel_resource_dependencies (source_table, resource) VALUES
  ('channels', 'channel.overview'), ('channels', 'channel.settings'), ('channels', 'channel.system'),
  ('channels', 'channels'),
  ('channel_members', 'channel.members'), ('channel_members', 'channel.overview'), ('channel_members', 'channels'),
  ('channel_modules', 'channel.overview'), ('channel_modules', 'channel.modules'), ('channel_modules', 'channel.variables'), ('channel_modules', 'channels'), ('channel_modules', 'module:*:settings'),
  ('bot_identity', 'channel.overview'), ('bot_identity', 'channel.system'), ('bot_identity', 'channels'),
  ('bot_identity_status', 'channel.overview'), ('bot_identity_status', 'channel.system'), ('bot_identity_status', 'channels'),
  ('bot_channel_status', 'channel.overview'), ('bot_channel_status', 'channel.system'), ('bot_channel_status', 'channels'),
  ('twitch_login_identity', 'channel.overview'), ('twitch_login_identity', 'channel.system'), ('twitch_login_identity', 'channels'),
  ('channel_controls', 'channel.overview'), ('channel_controls', 'channels'),
  ('channel_stream_state', 'channel.overview'), ('channel_stream_state', 'module:belabox:live'), ('channel_stream_state', 'channels'),
  ('twitch_connections', 'channel.overview'), ('twitch_connections', 'channel.system'), ('twitch_connections', 'channels'),
  ('eventsub_subscriptions', 'channel.overview'), ('eventsub_subscriptions', 'channel.system'), ('eventsub_subscriptions', 'channels'),
  ('eventsub_revocations', 'channel.system'),
  ('audit_log', 'channel.audit'),
  ('event_log', 'channel.events'), ('event_log', 'module:*:data'),
  ('channel_variables', 'channel.variables'), ('channel_variables', 'channel.overlays'), ('channel_variables', 'channel.library'),
  ('overlays', 'channel.overlays'), ('overlays', 'channel.variables'), ('overlays', 'channel.library'),
  ('overlay_elements', 'channel.overlays'), ('overlay_elements', 'channel.variables'), ('overlay_elements', 'channel.library'),
  ('overlay_tokens', 'channel.overlays'), ('overlay_tokens', 'channel.overlay-accesses'),
  ('text_commands', 'module:text_commands:commands'), ('text_commands', 'channel.variables'), ('text_commands', 'channel.library'),
  ('text_command_aliases', 'module:text_commands:commands'),
  ('text_library_settings', 'module:text_library:library'), ('text_library_settings', 'channel.library'),
  ('text_library_categories', 'module:text_library:library'), ('text_library_categories', 'channel.library'),
  ('text_blocks', 'module:text_library:library'), ('text_blocks', 'channel.library'),
  ('text_block_variants', 'module:text_library:library'), ('text_block_variants', 'channel.library'),
  ('timers', 'module:timers:panel'), ('timers', 'channel.library'),
  ('faq_entries', 'module:faq:panel'), ('faq_entries', 'channel.library'),
  ('chat_votes', 'module:chat_voting:panel'),
  ('chat_vote_term_approvals', 'module:chat_voting:panel'),
  ('votekicks', 'module:votekick:panel'),
  ('module_secrets', 'module:belabox:settings'), ('module_secrets', 'module:belabox:live'),
  ('belabox_status', 'module:belabox:live'), ('belabox_minutes', 'module:belabox:live'),
  ('belabox_streams', 'module:belabox:live'),
  ('ads_countdown_state', 'module:ads:schedule'),
  ('api_sources', 'module:api_source:sources'), ('api_sources', 'channel.library'),
  ('api_source_cache', 'api.cache'),
  ('weather_cache', 'weather.cache'),
  ('weather_settings', 'module:weather:provider-settings'), ('weather_settings', 'channel.library'),
  ('sun_settings', 'module:sun:error-texts'),
  ('moon_settings', 'module:moon:unavailable-texts');

CREATE INDEX panel_resource_dependencies_source_idx ON panel_resource_dependencies(source_table);

-- A trigger per operation makes revision advancement part of the same D1
-- transaction as the row write, including batches that later return an error.
CREATE TRIGGER panel_rev_channels_insert AFTER INSERT ON channels BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channels' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_channels_update AFTER UPDATE ON channels BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channels' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_channels_delete AFTER DELETE ON channels BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
  DELETE FROM panel_resource_revisions WHERE channel_id = OLD.channel_id;
END;

-- Channel-scoped tables share a small generated trigger body. These writers
-- are the commit seam for all route, EventSub, command, alarm and maintenance
-- code that persists dashboard-visible D1 rows.
CREATE TRIGGER panel_rev_members_insert AFTER INSERT ON channel_members BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_members' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_members_update AFTER UPDATE ON channel_members BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_members' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_members_delete AFTER DELETE ON channel_members BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_members' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_modules_insert AFTER INSERT ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource = 'module:*:settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_modules_update AFTER UPDATE ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, replace(resource, '*', NEW.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource = 'module:*:settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_modules_delete AFTER DELETE ON channel_modules BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, replace(resource, '*', OLD.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'channel_modules' AND resource = 'module:*:settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_bot_status_insert AFTER INSERT ON bot_channel_status BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'bot_channel_status' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_status_update AFTER UPDATE ON bot_channel_status BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'bot_channel_status' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_status_delete AFTER DELETE ON bot_channel_status BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'bot_channel_status' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_controls_insert AFTER INSERT ON channel_controls BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_controls' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_controls_update AFTER UPDATE ON channel_controls BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_controls' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_controls_delete AFTER DELETE ON channel_controls BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_controls' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_stream_insert AFTER INSERT ON channel_stream_state BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_stream_state' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_stream_update AFTER UPDATE ON channel_stream_state BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_stream_state' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_stream_delete AFTER DELETE ON channel_stream_state BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_stream_state' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_connection_insert AFTER INSERT ON twitch_connections BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_connections' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_connection_update AFTER UPDATE ON twitch_connections BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_connections' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_connection_delete AFTER DELETE ON twitch_connections BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'twitch_connections' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_subscriptions_insert AFTER INSERT ON eventsub_subscriptions BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'eventsub_subscriptions' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_subscriptions_update AFTER UPDATE ON eventsub_subscriptions BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'eventsub_subscriptions' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_subscriptions_delete AFTER DELETE ON eventsub_subscriptions BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'eventsub_subscriptions' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_revocations_insert AFTER INSERT ON eventsub_revocations BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies JOIN channels ON channels.channel_id = NEW.channel_id WHERE source_table = 'eventsub_revocations' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_revocations_update AFTER UPDATE ON eventsub_revocations BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies JOIN channels ON channels.channel_id = NEW.channel_id WHERE source_table = 'eventsub_revocations' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_revocations_delete AFTER DELETE ON eventsub_revocations BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies JOIN channels ON channels.channel_id = OLD.channel_id WHERE source_table = 'eventsub_revocations' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_audit_insert AFTER INSERT ON audit_log BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'audit_log' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_audit_update AFTER UPDATE ON audit_log BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'audit_log' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_audit_delete AFTER DELETE ON audit_log BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'audit_log' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

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
CREATE TRIGGER panel_rev_events_delete AFTER DELETE ON event_log BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource NOT LIKE 'module:%*%' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, replace(resource, '*', OLD.module_id), 1 FROM panel_resource_dependencies WHERE source_table = 'event_log' AND resource = 'module:*:data' AND OLD.module_id IS NOT NULL ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, 'module:ads:schedule', 1 WHERE OLD.module_id = 'ads' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_variables_insert AFTER INSERT ON channel_variables BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_variables' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_variables_update AFTER UPDATE ON channel_variables BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_variables' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_variables_delete AFTER DELETE ON channel_variables BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_variables' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_overlays_insert AFTER INSERT ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlays_update AFTER UPDATE ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlays_delete AFTER DELETE ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_insert AFTER INSERT ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_update AFTER UPDATE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_delete AFTER DELETE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_tokens_insert AFTER INSERT ON overlay_tokens BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_tokens' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_tokens_update AFTER UPDATE ON overlay_tokens BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_tokens' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_tokens_delete AFTER DELETE ON overlay_tokens BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_tokens' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Module tables use the same trigger pattern. The dependency rows above are
-- deliberately kept separate from route handlers so maintenance, alarms and
-- compensation writes receive the same coverage.
CREATE TRIGGER panel_rev_text_commands_insert AFTER INSERT ON text_commands BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_commands' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_commands_update AFTER UPDATE ON text_commands BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_commands' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_commands_delete AFTER DELETE ON text_commands BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_commands' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_command_aliases_insert AFTER INSERT ON text_command_aliases BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_command_aliases' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_command_aliases_update AFTER UPDATE ON text_command_aliases BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_command_aliases' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_command_aliases_delete AFTER DELETE ON text_command_aliases BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_command_aliases' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_library_settings_insert AFTER INSERT ON text_library_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_library_settings_update AFTER UPDATE ON text_library_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_library_settings_delete AFTER DELETE ON text_library_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_library_categories_insert AFTER INSERT ON text_library_categories BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_categories' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_library_categories_update AFTER UPDATE ON text_library_categories BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_categories' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_library_categories_delete AFTER DELETE ON text_library_categories BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_library_categories' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_blocks_insert AFTER INSERT ON text_blocks BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_blocks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_blocks_update AFTER UPDATE ON text_blocks BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_blocks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_blocks_delete AFTER DELETE ON text_blocks BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_blocks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_block_variants_insert AFTER INSERT ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_block_variants_update AFTER UPDATE ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_text_block_variants_delete AFTER DELETE ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_timers_insert AFTER INSERT ON timers BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'timers' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_timers_update AFTER UPDATE ON timers BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'timers' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_timers_delete AFTER DELETE ON timers BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'timers' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_faq_insert AFTER INSERT ON faq_entries BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'faq_entries' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_faq_update AFTER UPDATE ON faq_entries BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'faq_entries' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_faq_delete AFTER DELETE ON faq_entries BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'faq_entries' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_chat_votes_insert AFTER INSERT ON chat_votes BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_votes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_chat_votes_update AFTER UPDATE ON chat_votes BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_votes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_chat_votes_delete AFTER DELETE ON chat_votes BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_votes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_chat_vote_approvals_insert AFTER INSERT ON chat_vote_term_approvals BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_vote_term_approvals' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_chat_vote_approvals_update AFTER UPDATE ON chat_vote_term_approvals BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_vote_term_approvals' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_chat_vote_approvals_delete AFTER DELETE ON chat_vote_term_approvals BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'chat_vote_term_approvals' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_votekicks_insert AFTER INSERT ON votekicks BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'votekicks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_votekicks_update AFTER UPDATE ON votekicks BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'votekicks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_votekicks_delete AFTER DELETE ON votekicks BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'votekicks' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_module_secrets_insert AFTER INSERT ON module_secrets BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'module_secrets' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_module_secrets_update AFTER UPDATE ON module_secrets BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'module_secrets' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_module_secrets_delete AFTER DELETE ON module_secrets BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'module_secrets' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_status_insert AFTER INSERT ON belabox_status BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_status' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_status_update AFTER UPDATE ON belabox_status BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_status' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_status_delete AFTER DELETE ON belabox_status BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_status' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_minutes_insert AFTER INSERT ON belabox_minutes BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_minutes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_minutes_update AFTER UPDATE ON belabox_minutes BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_minutes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_minutes_delete AFTER DELETE ON belabox_minutes BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_minutes' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_streams_insert AFTER INSERT ON belabox_streams BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_streams' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_streams_update AFTER UPDATE ON belabox_streams BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_streams' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_belabox_streams_delete AFTER DELETE ON belabox_streams BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'belabox_streams' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_api_sources_insert AFTER INSERT ON api_sources BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_sources' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_api_sources_update AFTER UPDATE ON api_sources BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_sources' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_api_sources_delete AFTER DELETE ON api_sources BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'api_sources' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_api_source_cache_insert AFTER INSERT ON api_source_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache';
END;
CREATE TRIGGER panel_rev_api_source_cache_update AFTER UPDATE ON api_source_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache';
END;
CREATE TRIGGER panel_rev_api_source_cache_delete AFTER DELETE ON api_source_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'api.cache';
END;
CREATE TRIGGER panel_rev_weather_settings_insert AFTER INSERT ON weather_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'weather_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_weather_settings_update AFTER UPDATE ON weather_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'weather_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_weather_settings_delete AFTER DELETE ON weather_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'weather_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_sun_settings_insert AFTER INSERT ON sun_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'sun_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_sun_settings_update AFTER UPDATE ON sun_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'sun_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_sun_settings_delete AFTER DELETE ON sun_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'sun_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_moon_settings_insert AFTER INSERT ON moon_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'moon_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_moon_settings_update AFTER UPDATE ON moon_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'moon_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_moon_settings_delete AFTER DELETE ON moon_settings BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'moon_settings' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

-- Global bot identity and weather-cache commits fan out through every channel.
CREATE TRIGGER panel_rev_bot_identity_insert AFTER INSERT ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_update AFTER UPDATE ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_delete AFTER DELETE ON bot_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_insert AFTER INSERT ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_update AFTER UPDATE ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_bot_identity_status_delete AFTER DELETE ON bot_identity_status BEGIN
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.overview', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel_id, 'channel.system', 1 FROM channels WHERE 1 ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_login_identity_insert AFTER INSERT ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channels.channel_id, dependency.resource, 1 FROM channels JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members ON channel_members.channel_id = channels.channel_id WHERE channels.channel_id = NEW.user_id OR channel_members.user_id = NEW.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_login_identity_update AFTER UPDATE ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channels.channel_id, dependency.resource, 1 FROM channels JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members ON channel_members.channel_id = channels.channel_id WHERE channels.channel_id = NEW.user_id OR channel_members.user_id = NEW.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
CREATE TRIGGER panel_rev_login_identity_delete AFTER DELETE ON twitch_login_identity BEGIN
  INSERT INTO panel_resource_revisions SELECT DISTINCT channels.channel_id, dependency.resource, 1 FROM channels JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'twitch_login_identity' LEFT JOIN channel_members ON channel_members.channel_id = channels.channel_id WHERE channels.channel_id = OLD.user_id OR channel_members.user_id = OLD.user_id ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_weather_cache_insert AFTER INSERT ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
END;
CREATE TRIGGER panel_rev_weather_cache_update AFTER UPDATE ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
END;
CREATE TRIGGER panel_rev_weather_cache_delete AFTER DELETE ON weather_cache BEGIN
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'weather.cache';
END;

CREATE TRIGGER panel_rev_ads_countdown_insert AFTER INSERT ON ads_countdown_state BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'ads_countdown_state' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_ads_countdown_update AFTER UPDATE ON ads_countdown_state BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'ads_countdown_state' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_ads_countdown_delete AFTER DELETE ON ads_countdown_state BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'ads_countdown_state' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
