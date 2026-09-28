import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort();
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("timer stream id migration", () => {
  it("adds null-defaulted stream id columns without disturbing existing timer rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const target = "0024_timer_stream_id.sql";
      const targetIndex = migrationFiles.indexOf(target);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const priorMigrations = migrationFiles.slice(0, targetIndex);
      for (const file of priorMigrations) database.exec(migration(file));

      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-1', 'channel-1', 'Channel One', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO timers
          (timer_id, channel_id, name, enabled, block_name, trigger_type, trigger_json, revision,
           next_run_at, last_run_at, last_chat_activity_count, created_at, updated_at)
        VALUES
          ('timer-1', 'channel-1', 'Scheduled message', 1, 'welcome', 'interval',
           '{"type":"interval","minutes":10}', 1, '2026-09-27T12:10:00.000Z', NULL, 42,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      database.exec(migration(target));

      expect(database.prepare(
        `SELECT timer_id, next_run_at, next_run_stream_id, last_chat_activity_count, chat_baseline_stream_id
           FROM timers WHERE timer_id = 'timer-1'`,
      ).get()).toEqual({
        timer_id: "timer-1",
        next_run_at: "2026-09-27T12:10:00.000Z",
        next_run_stream_id: null,
        last_chat_activity_count: 42,
        chat_baseline_stream_id: null,
      });
    } finally {
      database.close();
    }
  });
});
