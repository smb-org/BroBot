-- Ereignisprotokoll für Modulverhalten.
--
-- Bewusst getrennt von audit_log: Das Audit ist rechtlich relevant, vollständig
-- und bleibt 24 Monate (Entscheidung 0003). Dieses Protokoll ist hochvolumig,
-- darf lückenhaft sein und wird nach 14 Tagen abgeräumt. Eine gemeinsame
-- Tabelle würde die 24-Monats-Frist auf Chatverkehr ausdehnen und das Audit in
-- Debug-Zeilen ertränken.
--
-- actor_user_id steht roh da, nicht gehasht. Das Panel muss zeigen, WER das
-- Kommando abgesetzt hat; ein Hash wäre dort wertlos. Die kurze Frist ist der
-- Schutz, nicht die Verfremdung. Ausnahme zum Hash-Modell aus 0003, dort
-- vermerkt.
CREATE TABLE event_log (
  event_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  module_id TEXT NOT NULL,
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  -- Null, wenn das Ereignis nicht von einer Person ausgelöst wurde
  -- (Zeitgeber, EventSub-Nachricht ohne Absender).
  actor_user_id TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX event_log_channel_created_idx ON event_log(channel_id, created_at);
