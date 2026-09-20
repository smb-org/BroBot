-- Die EventSub-Bedingung kann je Typ mehr als ein Ziel pro Kanal erzeugen.
-- Bestehende Abos haben die eindeutige Standardvariante.
CREATE TABLE eventsub_subscriptions_with_variant (
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  subscription_id TEXT,
  secret_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'missing', 'error', 'revoked')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, subscription_type, variant),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO eventsub_subscriptions_with_variant
  (channel_id, subscription_type, variant, subscription_id, secret_id, status, reason, updated_at)
SELECT channel_id, subscription_type, '', subscription_id, secret_id, status, reason, updated_at
  FROM eventsub_subscriptions;

DROP INDEX IF EXISTS eventsub_subscriptions_channel_idx;
DROP INDEX IF EXISTS eventsub_subscriptions_id_idx;
DROP TABLE eventsub_subscriptions;
ALTER TABLE eventsub_subscriptions_with_variant RENAME TO eventsub_subscriptions;

CREATE INDEX eventsub_subscriptions_channel_idx
  ON eventsub_subscriptions(channel_id, updated_at);

CREATE INDEX eventsub_subscriptions_id_idx
  ON eventsub_subscriptions(subscription_id);
