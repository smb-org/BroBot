ALTER TABLE song_requests ADD COLUMN channel_points_reward_id TEXT;
ALTER TABLE song_requests ADD COLUMN channel_points_resolution_due TEXT
  CHECK (channel_points_resolution_due IS NULL OR channel_points_resolution_due IN ('FULFILLED', 'CANCELED'));

CREATE INDEX song_requests_channel_points_resolution_due_idx
  ON song_requests(channel_id, channel_points_resolution_due, created_at, id);

ALTER TABLE channel_points_redemptions ADD COLUMN provider_resolution_due TEXT
  CHECK (provider_resolution_due IS NULL OR provider_resolution_due IN ('FULFILLED', 'CANCELED'));
ALTER TABLE channel_points_redemptions ADD COLUMN provider_module_id TEXT;
ALTER TABLE channel_points_redemptions ADD COLUMN provider_action_id TEXT;

CREATE INDEX channel_points_provider_resolution_due_idx
  ON channel_points_redemptions(channel_id, provider_resolution_due, redeemed_at, redemption_id);
