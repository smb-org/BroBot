-- EventSub-Versionen gehören zum lokalen Ziel: Ein v1-Abo ist für ein v2-Ziel
-- nicht passend und muss sichtbar ersetzt werden.
CREATE TABLE eventsub_subscriptions_with_version (
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1',
  subscription_id TEXT,
  secret_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'missing', 'error', 'revoked')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, subscription_type, variant, version),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO eventsub_subscriptions_with_version
  (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, updated_at)
SELECT channel_id, subscription_type, variant, '1', subscription_id, secret_id, status, reason, updated_at
  FROM eventsub_subscriptions;

DROP INDEX IF EXISTS eventsub_subscriptions_channel_idx;
DROP INDEX IF EXISTS eventsub_subscriptions_id_idx;
DROP TABLE eventsub_subscriptions;
ALTER TABLE eventsub_subscriptions_with_version RENAME TO eventsub_subscriptions;

CREATE INDEX eventsub_subscriptions_channel_idx
  ON eventsub_subscriptions(channel_id, updated_at);

CREATE INDEX eventsub_subscriptions_id_idx
  ON eventsub_subscriptions(subscription_id);
