-- Der lokale Soll-/Ist-Zustand je Kanal und EventSub-Typ.
-- Die Twitch-Liste bleibt autoritativ für die Existenz; diese Tabelle hält
-- zusätzlich fehlende, fehlgeschlagene und widerrufene Zustände für das Panel.
CREATE TABLE IF NOT EXISTS eventsub_subscriptions (
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  subscription_id TEXT,
  secret_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'missing', 'error', 'revoked')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, subscription_type),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS eventsub_subscriptions_channel_idx
  ON eventsub_subscriptions(channel_id, updated_at);

CREATE INDEX IF NOT EXISTS eventsub_subscriptions_id_idx
  ON eventsub_subscriptions(subscription_id);
