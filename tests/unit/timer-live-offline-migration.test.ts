import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  mapTimerRow,
  preserveOfflineIntervalForLegacyMutation,
  timerMutationInput,
  timerTriggerJson,
  type TimerRow,
} from "../../src/modules/timers/service";

const legacyIntervalReader = z.object({
  type: z.literal("interval"),
  minutes: z.number().int().min(1).max(24 * 60),
  minimumMessages: z.number().int().min(1).max(100_000).optional(),
});

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
const migration = (name: string): string => readFileSync(resolve(migrationsDirectory, name), "utf8");

describe("timer live and offline interval migration", () => {
  it("keeps legacy interval JSON readable before and after old-worker writes", () => {
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
           next_run_at, next_run_stream_id, last_run_at, last_chat_activity_count, created_at, updated_at)
        VALUES
          ('pending', 'channel-1', 'Live reminder', 1, 'Hello', 'interval',
           '{"type":"interval","minutes":12,"minimumMessages":4}', 7,
           '2026-10-13T12:12:00.000Z', 'stream-1', '2026-10-13T11:55:00.000Z', 42,
           '2026-01-01T00:00:00.000Z', '2026-10-13T11:00:00.000Z'),
          ('unarmed', 'channel-1', 'Unarmed reminder', 1, 'Hello', 'interval',
           '{"type":"interval","minutes":30}', 2,
           NULL, NULL, NULL, NULL,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);

      database.exec(migration(target));

      const pending = database.prepare(
        `SELECT trigger_json, revision, next_run_at, next_run_state,
                last_run_at, schedule_mirror_sequence, updated_at
           FROM timers WHERE timer_id = 'pending'`,
      ).get() as Record<string, unknown>;
      expect(JSON.parse(String(pending.trigger_json)) as unknown).toEqual({
        type: "interval", minutes: 12, minimumMessages: 4,
      });
      expect(pending).toMatchObject({
        revision: 7,
        next_run_at: "2026-10-13T12:12:00.000Z",
        next_run_state: "live",
        last_run_at: "2026-10-13T11:55:00.000Z",
        schedule_mirror_sequence: 0,
        updated_at: "2026-10-13T11:00:00.000Z",
      });
      const unarmed = database.prepare(
        "SELECT trigger_json, next_run_at, next_run_state FROM timers WHERE timer_id = 'unarmed'",
      ).get() as Record<string, unknown>;
      expect(JSON.parse(String(unarmed.trigger_json)) as unknown).toEqual({ type: "interval", minutes: 30 });
      expect(unarmed).toMatchObject({ next_run_at: null, next_run_state: null });

      const pendingRow = database.prepare(
        `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
                use_channel_default_target, revision, next_run_at, next_run_state,
                last_run_at, created_at, updated_at
           FROM timers WHERE timer_id = 'pending'`,
      ).get() as unknown as TimerRow;
      expect(mapTimerRow(pendingRow).trigger).toEqual({
        type: "interval", live: { minutes: 12, minimumMessages: 4 },
      });

      database.prepare("UPDATE timers SET trigger_json = ? WHERE timer_id = 'pending'")
        .run('{"type":"interval","minutes":9,"minimumMessages":2}');
      const oldWorkerWrite = database.prepare(
        `SELECT timer_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
                use_channel_default_target, revision, next_run_at, next_run_state,
                last_run_at, created_at, updated_at
           FROM timers WHERE timer_id = 'pending'`,
      ).get() as unknown as TimerRow;
      expect(mapTimerRow(oldWorkerWrite).trigger).toEqual({
        type: "interval", live: { minutes: 9, minimumMessages: 2 },
      });

      const dualStateTrigger = {
        type: "interval" as const,
        live: { minutes: 12, minimumMessages: 4 },
        offline: { minutes: 20 },
      };
      const compatibleJson = timerTriggerJson(dualStateTrigger);
      expect(JSON.parse(compatibleJson) as unknown).toEqual({
        ...dualStateTrigger,
        minutes: 12,
        minimumMessages: 4,
      });
      expect(mapTimerRow({ ...oldWorkerWrite, trigger_json: compatibleJson }).trigger).toEqual(dualStateTrigger);
      expect(legacyIntervalReader.safeParse(JSON.parse(compatibleJson) as unknown).data).toEqual({
        type: "interval", minutes: 12, minimumMessages: 4,
      });

      const offlineOnlyTrigger = { type: "interval" as const, offline: { minutes: 20 } };
      const offlineOnlyJson = timerTriggerJson(offlineOnlyTrigger);
      expect(JSON.parse(offlineOnlyJson) as unknown).toEqual(offlineOnlyTrigger);
      expect(legacyIntervalReader.safeParse(JSON.parse(offlineOnlyJson) as unknown).success).toBe(false);

      const legacyMutation = timerMutationInput({
        name: "Older client",
        messageText: "Hello",
        trigger: { type: "interval", minutes: 9, minimumMessages: 2 },
      });
      if (legacyMutation === null) throw new Error("The legacy interval mutation was rejected.");
      expect(legacyMutation.trigger).toEqual({
        type: "interval", live: { minutes: 9, minimumMessages: 2 },
      });
      expect(preserveOfflineIntervalForLegacyMutation(
        legacyMutation.trigger,
        dualStateTrigger,
        { type: "interval", minutes: 9, minimumMessages: 2 },
      )).toEqual({
        type: "interval",
        live: { minutes: 9, minimumMessages: 2 },
        offline: { minutes: 20 },
      });
    } finally {
      database.close();
    }
  });
});
