import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { mapTimerRow, type TimerRow } from "../../src/modules/timers/service";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql")).sort((left, right) => left.localeCompare(right));
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("timer Durable Object scheduler migration", () => {
  it("keeps the required legacy bootstrap columns and adds the DO mirror and repair outbox", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const target = "0061_timer_live_offline_intervals.sql";
      const targetIndex = migrationFiles.indexOf(target);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      for (const file of migrationFiles.slice(0, targetIndex)) database.exec(migration(file));

      database.exec(`
        INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
        VALUES ('channel-1', 'channel-1', 'Channel One', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO timers
          (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision,
           next_run_at, next_run_stream_id, last_chat_activity_count, created_at, updated_at)
        VALUES
          ('pending', 'channel-1', 'Offline reminder', 1, 'Hello', 'interval',
           '{"type":"interval","offline":{"minutes":12,"minimumMessages":4}}', 7,
           '2026-10-13T12:12:00.000Z', NULL, 42,
           '2026-01-01T00:00:00.000Z', '2026-10-13T11:00:00.000Z');
      `);

      database.exec(migration(target));

      const columns = database.prepare("PRAGMA table_info(timers)").all()
        .map((column) => (column as { name: string }).name);
      expect(columns).toContain("next_run_at");
      expect(columns).toContain("next_run_state");
      expect(columns).toContain("schedule_mirror_sequence");
      expect(columns).toContain("next_run_stream_id");
      expect(columns).toContain("last_chat_activity_count");
      expect(columns).toContain("chat_baseline_stream_id");
      expect(columns).not.toContain("next_run_generation");
      expect(columns).not.toContain("next_run_plan_sequence");

      const row = database.prepare(
        `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
                use_channel_default_target, revision, next_run_at, next_run_state,
                last_run_at, created_at, updated_at
           FROM timers WHERE timer_id = 'pending'`,
      ).get() as unknown as TimerRow;
      const timer = mapTimerRow(row);
      expect(timer).toMatchObject({
        revision: 7,
        nextRunAt: "2026-10-13T12:12:00.000Z",
        nextRunState: "live",
      });
      expect(timer.trigger).toEqual({
        type: "interval", offline: { minutes: 12, minimumMessages: 4 },
      });
      expect(database.prepare("SELECT schedule_mirror_sequence FROM timers WHERE timer_id = 'pending'").get())
        .toEqual({ schedule_mirror_sequence: 0 });
      expect(database.prepare("PRAGMA table_info(channel_stream_state)").all()
        .map((column) => (column as { name: string }).name)).toContain("transition_generation");
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("timer_schedule_reconciliation")).toEqual({ name: "timer_schedule_reconciliation" });
      expect(database.prepare("PRAGMA table_info(timer_schedule_reconciliation)").all()
        .map((column) => (column as { name: string }).name)).toContain("reason");
    } finally {
      database.close();
    }
  });
});
