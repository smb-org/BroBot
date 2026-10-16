ALTER TABLE channel_modules ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 1
  CHECK (settings_revision >= 1);

UPDATE channel_modules
   SET settings_revision = revision;
