import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("game search cache migration", () => {
  it("shares category cache rows while isolating recent categories by channel", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const target = "0058_game_search_cache.sql";
      const targetIndex = migrationFiles.indexOf(target);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      for (const file of migrationFiles.slice(0, targetIndex)) database.exec(migration(file));
      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-a', 'a', 'Channel A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
               ('channel-b', 'b', 'Channel B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      database.exec(migration(target));
      database.exec(`
        INSERT INTO twitch_game_search_cache (cache_key, games_json, expires_at_ms, updated_at_ms)
        VALUES ('search:zelda', '[{"id":"42","name":"Zelda"}]', 1790812800000, 1790726400000);
        INSERT INTO channel_game_history (channel_id, game_id, game_name, last_seen_at_ms)
        VALUES ('channel-a', '42', 'Zelda', 1790726400000),
               ('channel-b', '77', 'Elden Ring', 1790726400000);
      `);

      expect(database.prepare(
        "SELECT game_id, game_name FROM channel_game_history WHERE channel_id = 'channel-a'",
      ).all()).toEqual([{ game_id: "42", game_name: "Zelda" }]);
      expect(database.prepare(
        "SELECT game_id, game_name FROM channel_game_history WHERE channel_id = 'channel-b'",
      ).all()).toEqual([{ game_id: "77", game_name: "Elden Ring" }]);

      database.exec("DELETE FROM channels WHERE channel_id = 'channel-a'");
      expect(database.prepare("SELECT COUNT(*) AS count FROM channel_game_history WHERE channel_id = 'channel-a'").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM twitch_game_search_cache").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
