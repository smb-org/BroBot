import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModuleScheduleInputChangeReason } from "../../src/modules/contract";
import { handleTimerAlarm, timersModule } from "../../src/modules/timers";
import { TestD1Database } from "./test-d1";

let database: TestD1Database;
const channelId = "channel-1";
const timerId = "timer-1";
const firstDueAt = Date.parse("2026-09-27T12:10:00.000Z");
const secondDueAt = firstDueAt + 10 * 60_000;

const insertChannel = async (): Promise<void> => {
  await database.prepare("INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(channelId, "channelone", "Channel One", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
};

const insertTimer = async (input: {
  id?: string;
  name?: string;
  blockName?: string;
  trigger: unknown;
  triggerType: "interval" | "stream_start" | "time_of_day" | "before_event";
  nextRunAt?: number | null;
  activityCount?: number | null;
}): Promise<void> => {
  await database.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, block_name, trigger_type, trigger_json, revision,
       next_run_at, last_run_at, last_chat_activity_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
  ).bind(
    input.id ?? timerId,
    channelId,
    input.name ?? "Scheduled message",
    input.blockName ?? "welcome",
    input.triggerType,
    JSON.stringify(input.trigger),
    input.nextRunAt === undefined || input.nextRunAt === null ? null : new Date(input.nextRunAt).toISOString(),
    input.activityCount ?? 10,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ).run();
};

const prepareDatabase = async (): Promise<void> => {
  await insertChannel();
  await insertTimer({
    triggerType: "interval",
    trigger: { type: "interval", minutes: 10, minimumMessages: 3 },
    nextRunAt: firstDueAt,
    activityCount: 10,
  });
};

const contextFor = (
  activityCount: () => number,
  sends: string[],
  deadlines: number[],
  overrides: Partial<ModuleAlarmContext> = {},
): ModuleAlarmContext => ({
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
    return Promise.resolve({ sent: true, reason: null, retryable: false });
  },
  chatActivityCount: () => Promise.resolve(activityCount()),
  resolveEventTimes: () => Promise.resolve([]),
  streamState: () => Promise.resolve("online"),
  streamStartedAt: () => Promise.resolve({ streamId: null, startedAt: null }),
  ...overrides,
});

describe("timer alarm execution", () => {
  beforeEach(() => { database = new TestD1Database(); });
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
    expect(deadlines).toEqual([secondDueAt, secondDueAt, secondDueAt + 10 * 60_000]);
    await handleTimerAlarm(context, `timer:${timerId}`, secondDueAt);
    expect(sends).toHaveLength(1);
  });

  it("retries a known failed post without advancing the occurrence", async () => {
    await prepareDatabase();
    const sent: string[] = [];
    const deadlines: number[] = [];
    let attempts = 0;
    const context = contextFor(() => 13, sent, deadlines, {
      sendChat: (_text, key) => {
        attempts += 1;
        if (attempts === 1) return Promise.resolve({ sent: false, reason: "rate_limited", retryable: true });
        sent.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(firstDueAt);

    await expect(handleTimerAlarm(context, `timer:${timerId}`, firstDueAt)).rejects.toThrow("rate_limited");
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first<{ next_run_at: string }>())
      .toEqual({ next_run_at: new Date(firstDueAt).toISOString() });
    expect(deadlines).toEqual([]);

    vi.setSystemTime(firstDueAt + 5_000);
    await handleTimerAlarm(context, `timer:${timerId}`, firstDueAt);
    expect(deadlines).toEqual([secondDueAt]);
  });

  it("does not replace the existing alarm when its D1 deadline write fails", async () => {
    await prepareDatabase();
    const deadlines: number[] = [];
    let rejectNextDeadlineWrite = true;
    const failingDatabase = {
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        if (!/^\s*UPDATE timers SET next_run_at/u.test(sql)) return statement;
        return {
          bind: (...values: Parameters<typeof statement.bind>) => {
            const bound = statement.bind(...values);
            if (!rejectNextDeadlineWrite) return bound;
            return {
              run: () => {
                rejectNextDeadlineWrite = false;
                return Promise.reject(new Error("temporary D1 failure"));
              },
              first: (...args: Parameters<typeof bound.first>) => bound.first(...args),
              all: (...args: Parameters<typeof bound.all>) => bound.all(...args),
            };
          },
        };
      },
    } as unknown as D1Database;
    let delivered = false;
    const context = contextFor(() => 13, [], deadlines, {
      DB: failingDatabase,
      sendChat: () => {
        if (delivered) return Promise.resolve({ sent: false, reason: "already_attempted", retryable: false });
        delivered = true;
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(firstDueAt);

    await expect(handleTimerAlarm(context, `timer:${timerId}`, firstDueAt, 1)).rejects.toThrow("temporary D1 failure");
    expect(deadlines).toEqual([]);
    await handleTimerAlarm(context, `timer:${timerId}`, firstDueAt, 1);
    expect(deadlines).toEqual([secondDueAt]);
  });

  it("does not clear timer alarms for a stale offline notification", async () => {
    await prepareDatabase();
    const clearAlarm = vi.fn(() => Promise.resolve());
    const handleEvent = timersModule.handleEvent;
    if (handleEvent === undefined) throw new Error("Timer event handler is missing.");
    const event = {
      channelId,
      subscriptionType: "stream.offline",
      triggerId: "offline-event",
      payload: {},
      settings: {},
      receivedAt: new Date(firstDueAt).toISOString(),
      actor: null,
      chatStatus: null,
    } satisfies ModuleEvent;

    await handleEvent(event, {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: false,
      clearAlarm,
    } as unknown as ModuleExecutionContext);

    expect(clearAlarm).not.toHaveBeenCalled();
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first<{ next_run_at: string }>())
      .toEqual({ next_run_at: new Date(firstDueAt).toISOString() });
  });

  it("resets interval chat baselines only on an accepted stream start", async () => {
    await prepareDatabase();
    const handleEvent = timersModule.handleEvent;
    if (handleEvent === undefined) throw new Error("Timer event handler is missing.");
    const event = {
      channelId,
      subscriptionType: "stream.online",
      triggerId: "online-event",
      payload: { started_at: new Date(firstDueAt).toISOString(), id: "stream-1" },
      settings: {},
      receivedAt: new Date(firstDueAt).toISOString(),
      actor: null,
      chatStatus: null,
    } satisfies ModuleEvent;
    const context = {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      chatActivityCount: () => Promise.resolve(31),
      scheduleAlarm: () => Promise.resolve(),
    } as unknown as ModuleExecutionContext;

    await handleEvent(event, context);

    expect(await database.prepare("SELECT last_chat_activity_count FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ last_chat_activity_count: 31 });
  });

  it("replans event timers when a source becomes available or moves earlier", async () => {
    await insertChannel();
    const oldDue = Date.parse("2026-09-27T12:40:00.000Z");
    const earlierDue = Date.parse("2026-09-27T12:20:00.000Z");
    await insertTimer({
      triggerType: "before_event",
      trigger: { type: "before_event", sourceId: "schedule.release", minutes: 10 },
      nextRunAt: null,
      activityCount: null,
    });
    const deadlines: number[] = [];
    let eventAt = 0;
    const context = contextFor(() => 0, [], deadlines, {
      resolveEventTimes: () => Promise.resolve(eventAt === 0 ? [] : [{ id: "schedule.release", label: { de: "Ereignis", en: "Event" }, at: new Date(eventAt).toISOString() }]),
    });
    const onInputsChanged = timersModule.alarms?.[0]?.onScheduleInputsChanged;
    if (onInputsChanged === undefined) throw new Error("Timer schedule refresh hook is missing.");
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-27T12:00:00.000Z"));

    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([]);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: null });

    eventAt = Date.parse("2026-09-27T12:50:00.000Z");
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([oldDue]);
    eventAt = Date.parse("2026-09-27T12:30:00.000Z");
    deadlines.length = 0;
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([earlierDue]);
    eventAt = 0;
    deadlines.length = 0;
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([]);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: null });
  });

  it("replans daily timers after the channel time zone changes", async () => {
    await insertChannel();
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    await insertTimer({
      triggerType: "time_of_day",
      trigger: { type: "time_of_day", time: "13:00", weekdays: [], alsoOffline: false },
      nextRunAt: Date.parse("2026-09-27T11:00:00.000Z"),
      activityCount: null,
    });
    await database.prepare("UPDATE channels SET time_zone = 'America/New_York' WHERE channel_id = ?").bind(channelId).run();
    const deadlines: number[] = [];
    const context = contextFor(() => 0, [], deadlines);
    const onInputsChanged = timersModule.alarms?.[0]?.onScheduleInputsChanged;
    if (onInputsChanged === undefined) throw new Error("Timer schedule refresh hook is missing.");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await onInputsChanged(context, "channel_time_zone" satisfies ModuleScheduleInputChangeReason);

    expect(deadlines).toEqual([Date.parse("2026-09-27T17:00:00.000Z")]);
  });
});
