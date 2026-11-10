CREATE TABLE channel_points_rewards (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  twitch_reward_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 45),
  prompt TEXT,
  cost INTEGER NOT NULL CHECK (cost >= 1),
  background_color TEXT,
  is_user_input_required INTEGER NOT NULL CHECK (is_user_input_required IN (0, 1)),
  global_cooldown_seconds INTEGER CHECK (global_cooldown_seconds IS NULL OR global_cooldown_seconds BETWEEN 1 AND 604800),
  max_per_stream INTEGER CHECK (max_per_stream IS NULL OR max_per_stream BETWEEN 1 AND 1000000),
  max_per_user_per_stream INTEGER CHECK (max_per_user_per_stream IS NULL OR max_per_user_per_stream BETWEEN 1 AND 1000000),
  action_module_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_config_json TEXT NOT NULL CHECK (json_valid(action_config_json) AND json_type(action_config_json) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'queue')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  restore_enabled INTEGER CHECK (restore_enabled IS NULL OR restore_enabled IN (0, 1)),
  last_twitch_event_at TEXT,
  twitch_state TEXT NOT NULL CHECK (twitch_state IN ('active', 'deleted_on_twitch')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, id),
  UNIQUE (channel_id, twitch_reward_id)
);

CREATE INDEX channel_points_rewards_channel_idx ON channel_points_rewards(channel_id, created_at DESC, id);

CREATE TABLE channel_points_redemptions (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  redemption_id TEXT NOT NULL,
  reward_id TEXT NOT NULL,
  reward_title TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_input TEXT NOT NULL,
  redeemed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'running', 'queued', 'pending', 'fulfilled', 'refunded', 'failed_to_update')),
  claimed_at TEXT,
  pending_twitch_status TEXT CHECK (pending_twitch_status IS NULL OR pending_twitch_status IN ('FULFILLED', 'CANCELED')),
  outcome_reason_json TEXT CHECK (outcome_reason_json IS NULL OR json_valid(outcome_reason_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, redemption_id)
);

CREATE INDEX channel_points_redemptions_history_idx
  ON channel_points_redemptions(channel_id, redeemed_at DESC, redemption_id);
CREATE INDEX channel_points_redemptions_reward_idx
  ON channel_points_redemptions(channel_id, reward_id, redeemed_at DESC);
CREATE INDEX channel_points_redemptions_retry_idx
  ON channel_points_redemptions(channel_id, status, updated_at);

CREATE TABLE channel_points_reconcile_state (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  last_reconciled_at TEXT NOT NULL
);

INSERT INTO panel_resource_dependencies(source_table, resource)
VALUES ('channel_points_rewards', 'module:channel_points:data'),
       ('channel_points_redemptions', 'module:channel_points:data');

CREATE TRIGGER panel_rev_channel_points_rewards_insert AFTER INSERT ON channel_points_rewards BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_rewards'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_channel_points_rewards_update AFTER UPDATE ON channel_points_rewards
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.id IS NOT NEW.id OR OLD.twitch_reward_id IS NOT NEW.twitch_reward_id
  OR OLD.title IS NOT NEW.title OR OLD.prompt IS NOT NEW.prompt OR OLD.cost IS NOT NEW.cost
  OR OLD.background_color IS NOT NEW.background_color OR OLD.is_user_input_required IS NOT NEW.is_user_input_required
  OR OLD.global_cooldown_seconds IS NOT NEW.global_cooldown_seconds OR OLD.max_per_stream IS NOT NEW.max_per_stream
  OR OLD.max_per_user_per_stream IS NOT NEW.max_per_user_per_stream OR OLD.action_module_id IS NOT NEW.action_module_id
  OR OLD.action_id IS NOT NEW.action_id OR OLD.action_config_json IS NOT NEW.action_config_json
  OR OLD.mode IS NOT NEW.mode OR OLD.enabled IS NOT NEW.enabled OR OLD.restore_enabled IS NOT NEW.restore_enabled
  OR OLD.twitch_state IS NOT NEW.twitch_state
  OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_rewards'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_channel_points_rewards_delete AFTER DELETE ON channel_points_rewards BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_rewards'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_channel_points_redemptions_insert AFTER INSERT ON channel_points_redemptions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_redemptions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_channel_points_redemptions_update AFTER UPDATE ON channel_points_redemptions
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.redemption_id IS NOT NEW.redemption_id OR OLD.reward_id IS NOT NEW.reward_id
  OR OLD.reward_title IS NOT NEW.reward_title OR OLD.user_id IS NOT NEW.user_id OR OLD.user_login IS NOT NEW.user_login
  OR OLD.user_name IS NOT NEW.user_name OR OLD.user_input IS NOT NEW.user_input OR OLD.redeemed_at IS NOT NEW.redeemed_at
  OR OLD.status IS NOT NEW.status OR OLD.pending_twitch_status IS NOT NEW.pending_twitch_status
  OR OLD.outcome_reason_json IS NOT NEW.outcome_reason_json OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_redemptions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_channel_points_redemptions_delete AFTER DELETE ON channel_points_redemptions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'channel_points_redemptions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
