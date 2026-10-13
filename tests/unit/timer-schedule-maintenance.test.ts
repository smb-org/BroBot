import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearTimerScheduleReconciliation,
  timerScheduleReconciliationMutation,
  type TimerScheduleReconciliationRow,
} from "../../src/modules/contracts/timer-schedule-reconciliation";
import { maintainTimerSchedules } from "../../src/worker/timer-schedule-maintenance";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "timer-recovery-channel";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const environmentFor = (
  database: D1Database,
  reconcileTimerSchedules: (reason: TimerScheduleReconciliationRow["reason"]) => Promise<void>,
): Env => ({
  DB: database,
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ reconcileTimerSchedules }),
  },
} as unknown as Env);

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("timer schedule reconciliation outbox", () => {
  it("retains failed deliveries and replays them on a later maintenance tick", async () => {
    const database = await createDatabase();
    await timerScheduleReconciliationMutation(database as unknown as D1Database, CHANNEL_ID, "mutation-1", "2026-10-13T12:00:00.000Z").run();
    const reconcile = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("DO unavailable"));
    const environment = environmentFor(database as unknown as D1Database, reconcile);

    await maintainTimerSchedules(environment);
    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ mutation_id: "mutation-1" });

    reconcile.mockResolvedValue(undefined);
    await maintainTimerSchedules(environment);
    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not clear a newer mutation that arrives while an older repair is running", async () => {
    const database = await createDatabase();
    await timerScheduleReconciliationMutation(database as unknown as D1Database, CHANNEL_ID, "mutation-old", "2026-10-13T12:00:00.000Z").run();
    const reconcile = vi.fn(async () => {
      await timerScheduleReconciliationMutation(database as unknown as D1Database, CHANNEL_ID, "mutation-new", "2026-10-13T12:00:01.000Z").run();
    });

    await maintainTimerSchedules(environmentFor(database as unknown as D1Database, reconcile));

    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ mutation_id: "mutation-new" });
  });

  it("preserves a pending calendar repair when a later timer edit is queued", async () => {
    const database = await createDatabase();
    await timerScheduleReconciliationMutation(
      database as unknown as D1Database,
      CHANNEL_ID,
      "calendar-change",
      "2026-10-13T12:00:00.000Z",
      false,
      "event_times",
    ).run();
    await timerScheduleReconciliationMutation(
      database as unknown as D1Database,
      CHANNEL_ID,
      "timer-edit",
      "2026-10-13T12:00:01.000Z",
    ).run();
    await expect(database.prepare("SELECT mutation_id, reason FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ mutation_id: "timer-edit", reason: "channel_time_zone" });

    await clearTimerScheduleReconciliation(database as unknown as D1Database, CHANNEL_ID, "calendar-change");
    await clearTimerScheduleReconciliation(database as unknown as D1Database, CHANNEL_ID, "timer-edit", "activation");
    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ mutation_id: "timer-edit" });

    const reconcile = vi.fn<(reason: TimerScheduleReconciliationRow["reason"]) => Promise<void>>().mockResolvedValue(undefined);
    await maintainTimerSchedules(environmentFor(database as unknown as D1Database, reconcile));

    expect(reconcile).toHaveBeenCalledWith("channel_time_zone");
    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toBeNull();
  });

  it("preserves a pending activation repair when a later stream transition is queued", async () => {
    const database = await createDatabase();
    await timerScheduleReconciliationMutation(
      database as unknown as D1Database,
      CHANNEL_ID,
      "timer-edit",
      "2026-10-13T12:00:00.000Z",
      false,
      "activation",
    ).run();
    await timerScheduleReconciliationMutation(
      database as unknown as D1Database,
      CHANNEL_ID,
      "stream-change",
      "2026-10-13T12:00:01.000Z",
      false,
      "stream_state",
    ).run();

    await expect(database.prepare("SELECT mutation_id, reason FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ mutation_id: "stream-change", reason: "activation" });

    const reconcile = vi.fn<(reason: TimerScheduleReconciliationRow["reason"]) => Promise<void>>().mockResolvedValue(undefined);
    await maintainTimerSchedules(environmentFor(database as unknown as D1Database, reconcile));

    expect(reconcile).toHaveBeenCalledExactlyOnceWith("activation");
    await expect(database.prepare("SELECT mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toBeNull();
  });
});
