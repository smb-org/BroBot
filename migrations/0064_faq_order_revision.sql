CREATE TABLE faq_order_revision (
  channel_id TEXT PRIMARY KEY NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
) WITHOUT ROWID;

CREATE TABLE faq_entry_order (
  channel_id TEXT NOT NULL,
  faq_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (channel_id, faq_id),
  FOREIGN KEY (channel_id, faq_id) REFERENCES faq_entries(channel_id, faq_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX faq_entry_order_channel_order_idx ON faq_entry_order(channel_id, sort_order, faq_id);
DROP INDEX faq_entries_channel_order_idx;
DROP INDEX faq_entries_channel_enabled_order_idx;
CREATE INDEX faq_entries_channel_enabled_idx ON faq_entries(channel_id, enabled, faq_id);

INSERT INTO faq_order_revision (channel_id, revision)
SELECT channel_id, 1 FROM channel_modules WHERE module_id = 'faq';

INSERT INTO faq_order_revision (channel_id, revision)
SELECT DISTINCT channel_id, 1 FROM faq_entries
 WHERE channel_id NOT IN (SELECT channel_id FROM faq_order_revision);

INSERT INTO faq_entry_order (channel_id, faq_id, sort_order)
SELECT channel_id, faq_id, sort_order FROM faq_entries;

CREATE TRIGGER faq_order_revision_on_module_insert
AFTER INSERT ON channel_modules
WHEN NEW.module_id = 'faq'
BEGIN
  INSERT OR IGNORE INTO faq_order_revision (channel_id, revision) VALUES (NEW.channel_id, 1);
END;

CREATE TRIGGER faq_entry_order_on_insert
AFTER INSERT ON faq_entries
BEGIN
  INSERT OR IGNORE INTO faq_order_revision (channel_id, revision) VALUES (NEW.channel_id, 1);
  INSERT INTO faq_entry_order (channel_id, faq_id, sort_order)
  SELECT NEW.channel_id, NEW.faq_id, COALESCE(MAX(sort_order), -1) + 1
    FROM faq_entry_order WHERE channel_id = NEW.channel_id;
  UPDATE faq_order_revision SET revision = revision + 1 WHERE channel_id = NEW.channel_id;
END;

CREATE TRIGGER faq_order_revision_on_entry_delete
AFTER DELETE ON faq_entries
BEGIN
  UPDATE faq_order_revision SET revision = revision + 1 WHERE channel_id = OLD.channel_id;
END;

INSERT OR IGNORE INTO panel_resource_dependencies (source_table, resource)
VALUES ('faq_entry_order', 'module:faq:panel');

CREATE TRIGGER panel_rev_faq_entry_order_insert
AFTER INSERT ON faq_entry_order
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies
   WHERE source_table = 'faq_entry_order'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_faq_entry_order_update
AFTER UPDATE ON faq_entry_order
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies
   WHERE source_table = 'faq_entry_order'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_faq_entry_order_delete
AFTER DELETE ON faq_entry_order
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies
   WHERE source_table = 'faq_entry_order'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
