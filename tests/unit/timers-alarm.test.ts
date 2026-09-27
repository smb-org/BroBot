import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import { handleTimerAlarm } from "../../src/modules/timers";
import { TestD1Database } from "./test-d1";

const database = new TestD1Database();
const channelId = "channel-1";
const timerId = "timer-1";
const firstDueAt = Date.parse("2026-09-27T12:10:00.000Z");
const secondDueAt = firstDueAt + 10 * 60_000;

const prepareDatabase = async (): Promise<void> => {
  await database.prepare("INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(channelId, "channelone", "Channel One", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, block_name, trigger_type, trigger_json, revision,
       next_run_at, last_run_at, last_chat_activity_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, NULL, 10, ?, ?)`,
  ).bind(
    timerId,
    channelId,
    "Scheduled message",
    "welcome",
    "interval",
    JSON.stringify({ type: "interval", minutes: 10, minimumMessages: 3 }),
    new Date(firstDueAt).toISOString(),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ).run();
};

const contextFor = (activityCount: () => number, sends: string[], deadlines: number[]): ModuleAlarmContext => ({
  DB: database as unknown as D1Database,
  channelId,
  storage: {
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(true),
  },
  schedule: (_key, deadline) => { deadlines.push(deadline); return Promise.resolve(); },
  clear: () => Promise.resolve(),
  renderTemplate: () => Promise.resolve({ text: "Scheduled message" }),
  sendChat: (_text, idempotencyKey) => {
    sends.push(idempotencyKey);
    return Promise.resolve({ sent: true, reason: null });
  },
  chatActivityCount: () => Promise.resolve(activityCount()),
  resolveEventTimes: () => Promise.resolve([]),
  streamState: () => Promise.resolve("online"),
  streamStartedAt: () => Promise.resolve({ streamId: null, startedAt: null }),
});

describe("timer alarm execution", () => {
  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it("waits for the configured chat activity threshold and ignores a duplicate due alarm", async () => {
    await prepareDatabase();
    const sends: string[] = [];
    const deadlines: number[] = [];
    let activityCount = 12;
    const context = contextFor(() => activityCount, sends, deadlines);

    vi.useFakeTimers();
    vi.setSystemTime(firstDueAt);
    await handleTimerAlarm(context, `timer:${timerId}`, firstDueAt);
    expect(sends).toEqual([]);
    expect(deadlines).toEqual([secondDueAt]);

    await handleTimerAlarm(context, `timer:${timerId}`, firstDueAt);
    expect(sends).toEqual([]);

    activityCount = 13;
    vi.setSystemTime(secondDueAt);
    await handleTimerAlarm(context, `timer:${timerId}`, secondDueAt);
    expect(sends).toEqual([`${timerId}:${String(secondDueAt)}`]);
    expect(deadlines).toEqual([secondDueAt, secondDueAt + 10 * 60_000]);
    await handleTimerAlarm(context, `timer:${timerId}`, secondDueAt);
    expect(sends).toHaveLength(1);
  });
});
