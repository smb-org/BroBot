import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("FAQ order migration", () => {
  it("backfills order state and tracks later entry and FAQ module changes", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(migration("0000_baseline.sql"));
      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('existing', 'existing', 'Existing', '2026-10-14', '2026-10-14')`,
      ).run();
      database.exec(migration("0027_faq.sql"));
      database.exec(`
        CREATE TABLE panel_resource_dependencies (
          source_table TEXT NOT NULL,
          resource TEXT NOT NULL,
          PRIMARY KEY (source_table, resource)
        );
        CREATE TABLE panel_resource_revisions (
          channel_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (channel_id, resource)
        );
      `);
      database.prepare(
        `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_block, sort_order, created_at, updated_at)
         VALUES ('first', 'existing', 'First', '{"type":"keywords","patterns":["first"]}', 'first', 0, '2026-10-14', '2026-10-14'),
                ('second', 'existing', 'Second', '{"type":"keywords","patterns":["second"]}', 'second', 1, '2026-10-14', '2026-10-14')`,
      ).run();

      database.exec(migration("0064_faq_order_revision.sql"));

      expect(database.prepare(
        "SELECT faq_id, sort_order FROM faq_entry_order WHERE channel_id = 'existing' ORDER BY sort_order",
      ).all()).toEqual([
        { faq_id: "first", sort_order: 0 },
        { faq_id: "second", sort_order: 1 },
      ]);
      expect(database.prepare(
        "SELECT revision FROM faq_order_revision WHERE channel_id = 'existing'",
      ).get()).toEqual({ revision: 1 });
      database.prepare(
        "UPDATE faq_entry_order SET sort_order = 1 WHERE channel_id = 'existing' AND faq_id = 'first'",
      ).run();
      expect(database.prepare(
        "SELECT revision FROM panel_resource_revisions WHERE channel_id = 'existing' AND resource = 'module:faq:panel'",
      ).get()).toEqual({ revision: 1 });

      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('new', 'new', 'New', '2026-10-14', '2026-10-14')`,
      ).run();
      database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('new', 'faq', 1, '{}')",
      ).run();
      database.prepare(
        `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_block, sort_order, created_at, updated_at)
         VALUES ('new-entry', 'new', 'New entry', '{"type":"keywords","patterns":["new"]}', 'new_entry', 0, '2026-10-14', '2026-10-14')`,
      ).run();

      expect(database.prepare(
        "SELECT revision FROM faq_order_revision WHERE channel_id = 'new'",
      ).get()).toEqual({ revision: 2 });
      expect(database.prepare(
        "SELECT faq_id, sort_order FROM faq_entry_order WHERE channel_id = 'new'",
      ).all()).toEqual([{ faq_id: "new-entry", sort_order: 0 }]);

      database.prepare("DELETE FROM faq_entries WHERE channel_id = 'new' AND faq_id = 'new-entry'").run();
      expect(database.prepare(
        "SELECT revision FROM faq_order_revision WHERE channel_id = 'new'",
      ).get()).toEqual({ revision: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM faq_entry_order WHERE channel_id = 'new'").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
