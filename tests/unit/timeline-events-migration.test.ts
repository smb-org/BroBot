import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const readMigration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("timeline events migration", () => {
  it("keeps one event per identity and deletes a channel's timeline with the channel", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      const priorMigrations = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql") && name < "0079_channel_timeline.sql")
        .sort((left, right) => left.localeCompare(right));
      for (const migration of priorMigrations) database.exec(readMigration(migration));
      database.exec(readMigration("0079_channel_timeline.sql"));

      database.prepare(
        `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
         VALUES ('channel-a', 'channel-a', 'Channel A', 'now', 'now')`,
      ).run();
      const insert = database.prepare(
        `INSERT INTO channel_timeline_events
          (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
         VALUES ('channel-a', 'event-1', 'stream-1', '2026-10-25T12:00:00.000Z', 'clip_created', '{"clipId":"clip-1"}')
         ON CONFLICT (channel_id, event_key) DO NOTHING`,
      );
      insert.run();
      insert.run();

      expect(database.prepare("SELECT COUNT(*) AS count FROM channel_timeline_events").get()).toEqual({ count: 1 });
      database.prepare("DELETE FROM channels WHERE channel_id = 'channel-a'").run();
      expect(database.prepare("SELECT COUNT(*) AS count FROM channel_timeline_events").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
