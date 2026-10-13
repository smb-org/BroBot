import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("text block rename migration", () => {
  it("cascades a renamed block key to its variants and preserves their choice state", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const target = "0057_text_block_rename.sql";
      const targetIndex = migrationFiles.indexOf(target);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      expect(migrationFiles[targetIndex - 1]).toBe("0056_faq_person_cooldowns.sql");
      for (const file of migrationFiles.slice(0, targetIndex)) database.exec(readMigration(file));

      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channela', 'Channel A', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at)
        VALUES ('channel-a', 'social', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
        VALUES ('channel-a', 'welcome', 'social', 1, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');
        INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json, last_chosen_index)
        VALUES ('channel-a', 'welcome', 'default', 0, '{}', '["Hello"]', 2);
      `);
      database.exec(readMigration(target));

      database.prepare("UPDATE text_blocks SET block_name = 'greeting' WHERE channel_id = 'channel-a' AND block_name = 'welcome'").run();

      expect(database.prepare("SELECT block_name, last_chosen_index FROM text_block_variants WHERE channel_id = 'channel-a'").all())
        .toEqual([{ block_name: "greeting", last_chosen_index: 2 }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("SELECT rename_token FROM text_blocks WHERE channel_id = 'channel-a'").all())
        .toEqual([{ rename_token: null }]);
    } finally {
      database.close();
    }
  });
});
