-- Zustände des EventSub-Eingangs.
-- Die Message-ID ist Twitchs Wiederholungskennung und bleibt mindestens über
-- das dokumentierte Replay-Fenster hinaus erhalten.
CREATE TABLE IF NOT EXISTS eventsub_messages (
  message_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS eventsub_messages_received_idx ON eventsub_messages(received_at);

-- Ein Widerruf bleibt sichtbar, auch wenn Twitch das Abonnement bei sich
-- bereits entfernt hat. channel_id ist der Mandantenschlüssel für das Panel.
CREATE TABLE IF NOT EXISTS eventsub_revocations (
  subscription_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  subscription_type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  revoked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS eventsub_revocations_channel_idx
  ON eventsub_revocations(channel_id, revoked_at);

-- App Access Tokens haben kein Refresh-Token. Der einzige Datensatz wird
-- verschlüsselt gespeichert und per CAS rotiert, damit parallele Worker keinen
-- gültigen Token überschreiben.
CREATE TABLE IF NOT EXISTS twitch_app_access_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
