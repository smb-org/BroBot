-- Avoid fan-out panel revision writes when these rows only change bookkeeping.
DROP TRIGGER panel_rev_bot_identity_update;
DROP TRIGGER panel_rev_bot_identity_status_update;
DROP TRIGGER panel_rev_subscriptions_update;

CREATE TRIGGER panel_rev_bot_identity_update AFTER UPDATE ON bot_identity
WHEN OLD.id IS NOT NEW.id
  OR OLD.user_id IS NOT NEW.user_id
  OR OLD.login IS NOT NEW.login
  OR OLD.scopes_json IS NOT NEW.scopes_json
  OR OLD.access_token_ciphertext IS NOT NEW.access_token_ciphertext
  OR OLD.refresh_token_ciphertext IS NOT NEW.refresh_token_ciphertext
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.missing_scopes_json IS NOT NEW.missing_scopes_json
BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_bot_identity_status_update AFTER UPDATE ON bot_identity_status
WHEN OLD.id IS NOT NEW.id
  OR OLD.status IS NOT NEW.status
  OR OLD.reason IS NOT NEW.reason
BEGIN
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, dependency.resource, 1 FROM channels AS channel JOIN panel_resource_dependencies AS dependency ON dependency.source_table = 'bot_identity_status' WHERE dependency.resource NOT IN ('channels', 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions SELECT channel.channel_id, 'module:' || module.module_id || ':settings', 1 FROM channels AS channel JOIN channel_modules AS module ON module.channel_id = channel.channel_id WHERE EXISTS (SELECT 1 FROM panel_resource_dependencies WHERE source_table = 'bot_identity_status' AND resource = 'module:*:settings') ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;

CREATE TRIGGER panel_rev_subscriptions_update AFTER UPDATE ON eventsub_subscriptions
WHEN OLD.channel_id IS NOT NEW.channel_id
  OR OLD.subscription_type IS NOT NEW.subscription_type
  OR OLD.variant IS NOT NEW.variant
  OR OLD.version IS NOT NEW.version
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.secret_id IS NOT NEW.secret_id
  OR OLD.status IS NOT NEW.status
  OR OLD.reason IS NOT NEW.reason
  OR OLD.error_message IS NOT NEW.error_message
  OR OLD.error_status IS NOT NEW.error_status
BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'eventsub_subscriptions' AND resource <> 'channels' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  UPDATE panel_global_resource_revisions SET revision = revision + 1 WHERE resource = 'channels';
END;
