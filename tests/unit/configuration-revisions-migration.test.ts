import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("configuration revisions and alias index migration", () => {
  it("applies 0000 through 0008 to seeded data and preserves keys, indexes, and foreign keys", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(migration("0000_baseline.sql"));
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'channel-a', 'Channel A', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
        VALUES ('channel-a', 'editor', 1, '{"marker":"keep"}');
        INSERT INTO text_commands (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
        VALUES ('channel-a', 'hello', 'Hello', 7, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
        INSERT INTO text_commands (channel_id, command_name, response_text, cooldown_seconds, created_at, updated_at)
        VALUES ('channel-a', 'zebra', 'Zebra', 7, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
      `);

      for (const name of [
        "0001_eventsub_maintenance_locks.sql",
        "0002_text_command_options.sql",
        "0003_text_command_kinds.sql",
        "0004_channel_controls.sql",
        "0005_clips_default_on.sql",
        "0006_stream_started_at.sql",
        "0007_audit_log_filter_indexes.sql",
      ]) database.exec(migration(name));

      database.exec(`
        UPDATE text_commands
           SET aliases_json = '["hello-there","greeting"]', user_cooldown_seconds = 30,
               template_fields_json = '{"offlineText":"Offline"}'
         WHERE channel_id = 'channel-a' AND command_name = 'hello';
        UPDATE text_commands SET aliases_json = '["greeting","zebra-only"]'
         WHERE channel_id = 'channel-a' AND command_name = 'zebra';
        INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
        VALUES ('channel-a', 'hello', 'viewer-a', '2026-09-23T00:01:00.000Z');
      `);
      database.exec(migration("0008_configuration_revisions_and_alias_index.sql"));

      expect(database.prepare(
        `SELECT response_text, cooldown_seconds, aliases_json, user_cooldown_seconds,
                template_fields_json, revision
           FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'hello'`,
      ).get()).toEqual({
        response_text: "Hello",
        cooldown_seconds: 7,
        aliases_json: '["hello-there","greeting"]',
        user_cooldown_seconds: 30,
        template_fields_json: '{"offlineText":"Offline"}',
        revision: 1,
      });
      expect(database.prepare(
        "SELECT aliases_json FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'zebra'",
      ).get()).toEqual({ aliases_json: '["zebra-only"]' });
      expect(database.prepare(
        "SELECT settings, revision FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'editor'",
      ).get()).toEqual({ settings: '{"marker":"keep"}', revision: 1 });
      expect(database.prepare(
        "SELECT alias, command_name FROM text_command_aliases ORDER BY alias",
      ).all()).toEqual([
        { alias: "greeting", command_name: "hello" },
        { alias: "hello-there", command_name: "hello" },
        { alias: "zebra-only", command_name: "zebra" },
      ]);
      expect(database.prepare(
        `SELECT enabled, settings FROM channel_modules
          WHERE channel_id = 'channel-a' AND module_id = 'clips'`,
      ).get()).toEqual({ enabled: 1, settings: "{}" });

      const aliasPlan = database.prepare(
        "EXPLAIN QUERY PLAN SELECT command_name FROM text_command_aliases WHERE channel_id = ? AND alias = ?",
      ).all("channel-a", "greeting") as Array<{ detail: string }>;
      expect(aliasPlan.some(({ detail }) => /PRIMARY KEY|sqlite_autoindex_text_command_aliases/i.test(detail))).toBe(true);
      const aliasIndexes = database.prepare("PRAGMA index_list(text_command_aliases)").all() as Array<{ name: string }>;
      expect(aliasIndexes.map(({ name }) => name)).toContain("text_command_aliases_command_idx");
      expect(database.prepare("PRAGMA foreign_key_list(text_command_aliases)").all()).toHaveLength(3);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      database.prepare("DELETE FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'hello'").run();
      database.prepare("DELETE FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'zebra'").run();
      expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_aliases").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
