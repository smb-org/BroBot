-- Jede neue Kanalzeile startet deutsch; vorhandene Kanäle erhalten denselben
-- Vorgabewert beim Anwenden dieser Migration.
ALTER TABLE channels ADD COLUMN language TEXT NOT NULL DEFAULT 'de'
  CHECK (language IN ('de', 'en'));
