import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModuleScheduleInputChangeReason } from "../../src/modules/contract";
import { handleTimerAlarm, timersModule } from "../../src/modules/timers";
import { calculateSunDay, localDateInTimeZone, shiftLocalDate } from "../../src/modules/sun/domain";
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

  it("does not send an interval post if the stream ends between the due-occurrence check and the send", async () => {
    await insertChannel();
    await insertTimer({
      id: "interval-recheck",
      triggerType: "interval",
      trigger: { type: "interval", minutes: 10 },
      nextRunAt: firstDueAt,
      activityCount: null,
    });
    let state: "online" | "offline" = "online";
    const sends: string[] = [];
    const deadlines: number[] = [];
    const context = contextFor(() => 0, sends, deadlines, {
      streamState: () => Promise.resolve(state),
      sendChat: (_text, key, _attributions, stillValid) => {
        // The gap between the due-occurrence check above (already passed,
        // since this callback is running at all) and the actual send is
        // exactly where `renderTemplate` and the chat-activity lookup run.
        state = "offline";
        return (stillValid?.() ?? Promise.resolve(true)).then((ok) => {
          if (ok) sends.push(key);
          return { sent: ok, reason: ok ? null : "stream_ended", retryable: false };
        });
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(firstDueAt);

    await handleTimerAlarm(context, "timer:interval-recheck", firstDueAt);

    expect(sends).toEqual([]);
  });

  it("does not send a stream-start post if the stream rolls over to a new one between the due-occurrence check and the send", async () => {
    await insertChannel();
    const streamStartedAt = new Date(firstDueAt - 10 * 60_000).toISOString();
    await insertTimer({
      id: "stream-start-recheck",
      triggerType: "stream_start",
      trigger: { type: "stream_start", minutes: 10 },
      nextRunAt: firstDueAt,
      activityCount: null,
    });
    await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", "stream-start-recheck").run();
    let streamId = "stream-1";
    const sends: string[] = [];
    const deadlines: number[] = [];
    const context = contextFor(() => 0, sends, deadlines, {
      streamState: () => Promise.resolve("online"),
      streamStartedAt: () => Promise.resolve({ streamId, startedAt: streamStartedAt }),
      sendChat: (_text, key, _attributions, stillValid) => {
        // A new stream starts (still short enough a gap that the alarm's
        // own occurrence check above already ran against the old one).
        streamId = "stream-2";
        return (stillValid?.() ?? Promise.resolve(true)).then((ok) => {
          if (ok) sends.push(key);
          return { sent: ok, reason: ok ? null : "stream_rolled_over", retryable: false };
        });
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(firstDueAt);

    await handleTimerAlarm(context, "timer:stream-start-recheck", firstDueAt);

    expect(sends).toEqual([]);
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

  it("replans event timers when a source becomes available or moves earlier, and replans a horizon check while none is found", async () => {
    await insertChannel();
    const start = Date.parse("2026-09-27T12:00:00.000Z");
    const horizon = start + 14 * 24 * 60 * 60_000;
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
    vi.setSystemTime(start);

    // No event within the source's horizon: instead of clearing the alarm
    // outright, the timer schedules a replan check at the horizon so it
    // keeps looking rather than going dormant forever.
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([horizon]);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: null });

    deadlines.length = 0;
    eventAt = Date.parse("2026-09-27T12:50:00.000Z");
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([oldDue]);
    deadlines.length = 0;
    eventAt = Date.parse("2026-09-27T12:30:00.000Z");
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([earlierDue]);
    deadlines.length = 0;
    eventAt = 0;
    await onInputsChanged(context, "event_times");
    expect(deadlines).toEqual([horizon]);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: null });
  });

  it("replans a before-event timer at the horizon through a Tromsø polar night instead of going dormant, then arms it once the sun returns", async () => {
    await insertChannel();
    const tromso = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo" };
    const sourceId = "sun.sunrise";
    const sunriseEventsFrom = (now: number): readonly string[] => {
      const today = localDateInTimeZone(now, tromso.timeZone);
      return Array.from({ length: 16 }, (_, index) => calculateSunDay({ ...tromso, localDate: shiftLocalDate(today, index - 1) }))
        .flatMap((day) => day.sunriseAt !== null && Date.parse(day.sunriseAt) > now ? [day.sunriseAt] : []);
    };
    await insertTimer({
      triggerType: "before_event",
      trigger: { type: "before_event", sourceId, minutes: 30 },
      nextRunAt: null,
      activityCount: null,
    });
    const scheduled: { key: string; deadline: number }[] = [];
    const context: ModuleAlarmContext = {
      DB: database as unknown as D1Database,
      channelId,
      storage: { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(true) },
      schedule: (key, deadline) => { scheduled.push({ key, deadline }); return Promise.resolve(); },
      clear: () => Promise.resolve(),
      renderTemplate: () => Promise.resolve({ text: "Scheduled message" }),
      sendChat: () => Promise.resolve({ sent: true, reason: null, retryable: false }),
      chatActivityCount: () => Promise.resolve(0),
      resolveEventTimes: (now) => Promise.resolve(sunriseEventsFrom(now).map((at) => ({ id: sourceId, label: { de: "Sonnenaufgang", en: "Sunrise" }, at }))),
      streamState: () => Promise.resolve("online"),
      streamStartedAt: () => Promise.resolve({ streamId: null, startedAt: null }),
    };
    const onInputsChanged = timersModule.alarms?.[0]?.onScheduleInputsChanged;
    if (onInputsChanged === undefined) throw new Error("Timer schedule refresh hook is missing.");

    vi.useFakeTimers();
    let now = Date.parse("2026-12-21T12:00:00.000Z");
    vi.setSystemTime(now);
    expect(sunriseEventsFrom(now)).toEqual([]);

    await onInputsChanged(context, "event_times");
    expect(scheduled).toHaveLength(1);
    const firstReplan = scheduled[0];
    if (firstReplan === undefined) throw new Error("Expected a horizon replan alarm.");
    expect(firstReplan.key).not.toBe(`timer:${timerId}`);
    expect(firstReplan.deadline).toBe(now + 14 * 24 * 60 * 60_000);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: null });

    // The horizon alarm fires two weeks later. By then the sun has returned
    // within the source's own 16-day horizon, so the timer must arm its real
    // alarm key for the next sunrise rather than schedule yet another
    // horizon check.
    now = firstReplan.deadline;
    vi.setSystemTime(now);
    const events = [...sunriseEventsFrom(now)].sort((left, right) => Date.parse(left) - Date.parse(right));
    expect(events.length).toBeGreaterThan(0);
    const nextSunriseAt = events[0];
    if (nextSunriseAt === undefined) throw new Error("Expected the source to report a sunrise by the horizon.");
    scheduled.length = 0;
    await handleTimerAlarm(context, firstReplan.key, firstReplan.deadline);
    expect(scheduled).toHaveLength(1);
    const rearmed = scheduled[0];
    if (rearmed === undefined) throw new Error("Expected the timer to arm once its source reports an event again.");
    expect(rearmed.key).toBe(`timer:${timerId}`);
    expect(rearmed.deadline).toBe(Date.parse(nextSunriseAt) - 30 * 60_000);
    expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind(timerId).first())
      .toEqual({ next_run_at: new Date(rearmed.deadline).toISOString() });
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

  describe("stream-id mismatch when an alarm fires (short inter-stream gap)", () => {
    it("rearms an interval timer for the new stream instead of firing it on a deadline left over from the previous one", async () => {
      await prepareDatabase();
      await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", timerId).run();
      const sends: string[] = [];
      const deadlines: number[] = [];
      // The new stream started only two minutes before the stale alarm fires
      // -- too short a gap for a start-time comparison to distinguish from
      // "already armed for this stream".
      const context = contextFor(() => 50, sends, deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: new Date(firstDueAt - 2 * 60_000).toISOString() }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(firstDueAt);

      await handleTimerAlarm(context, `timer:${timerId}`, firstDueAt);

      expect(sends).toEqual([]);
      expect(deadlines).toEqual([firstDueAt + 10 * 60_000]);
      expect(await database.prepare(
        "SELECT next_run_stream_id, last_chat_activity_count FROM timers WHERE timer_id = ?",
      ).bind(timerId).first()).toEqual({ next_run_stream_id: "stream-2", last_chat_activity_count: 50 });
    });

    it("rearms a stream-start timer for the new stream instead of firing it on a deadline left over from the previous one", async () => {
      await insertChannel();
      await insertTimer({
        id: "stream-start-timer",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 10 },
        nextRunAt: firstDueAt,
        activityCount: null,
      });
      await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", "stream-start-timer").run();
      const sends: string[] = [];
      const deadlines: number[] = [];
      const newStreamStartedAt = new Date(firstDueAt - 2 * 60_000).toISOString();
      const context = contextFor(() => 0, sends, deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: newStreamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(firstDueAt);

      await handleTimerAlarm(context, "timer:stream-start-timer", firstDueAt);

      expect(sends).toEqual([]);
      const expectedDeadline = Date.parse(newStreamStartedAt) + 10 * 60_000;
      expect(deadlines).toEqual([expectedDeadline]);
      expect(await database.prepare(
        "SELECT next_run_at, next_run_stream_id FROM timers WHERE timer_id = ?",
      ).bind("stream-start-timer").first()).toEqual({
        next_run_at: new Date(expectedDeadline).toISOString(),
        next_run_stream_id: "stream-2",
      });
    });

    it("fires (rather than deferring) an interval timer whose legacy row (null stream id, from before migration 0024) is already due inside the current stream", async () => {
      await insertChannel();
      await insertTimer({
        id: "interval-legacy",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 10 },
        nextRunAt: firstDueAt,
        activityCount: 5,
      });
      // next_run_stream_id is left at its migrated-in NULL default -- a row
      // armed before the stream-id column existed.
      const sends: string[] = [];
      const deadlines: number[] = [];
      const context = contextFor(() => 0, sends, deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-9", startedAt: new Date(firstDueAt - 5 * 60_000).toISOString() }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(firstDueAt);

      await handleTimerAlarm(context, "timer:interval-legacy", firstDueAt);

      expect(sends).toEqual([`interval-legacy:${String(firstDueAt)}`]);
      expect(deadlines).toEqual([firstDueAt + 10 * 60_000]);
      expect(await database.prepare(
        "SELECT next_run_at, next_run_stream_id FROM timers WHERE timer_id = ?",
      ).bind("interval-legacy").first()).toEqual({
        next_run_at: new Date(firstDueAt + 10 * 60_000).toISOString(),
        next_run_stream_id: "stream-9",
      });
    });

    it("fires (rather than dropping) a stream-start timer whose legacy row (null stream id, from before migration 0024) is already due inside the current stream", async () => {
      await insertChannel();
      await insertTimer({
        id: "stream-start-legacy",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 10 },
        nextRunAt: firstDueAt,
        activityCount: null,
      });
      const sends: string[] = [];
      const deadlines: number[] = [];
      const context = contextFor(() => 0, sends, deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-9", startedAt: new Date(firstDueAt - 10 * 60_000).toISOString() }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(firstDueAt);

      await handleTimerAlarm(context, "timer:stream-start-legacy", firstDueAt);

      expect(sends).toEqual([`stream-start-legacy:${String(firstDueAt)}:stream-9`]);
    });
  });

  describe("activation replan (module re-enable / channel unpause)", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    // Two minutes before "now": the stream-start timer's 5-minute delay is
    // still ahead of "now", so its due time is still in the future.
    const streamStartedAt = "2026-09-27T11:58:00.000Z";

    const onInputsChangedOf = (): NonNullable<NonNullable<typeof timersModule.alarms>[number]["onScheduleInputsChanged"]> => {
      const onInputsChanged = timersModule.alarms?.[0]?.onScheduleInputsChanged;
      if (onInputsChanged === undefined) throw new Error("Timer schedule refresh hook is missing.");
      return onInputsChanged;
    };

    it("arms an unarmed interval and stream-start timer for the running live session", async () => {
      await insertChannel();
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15 },
        nextRunAt: null,
        activityCount: null,
      });
      await insertTimer({
        id: "stream-start-timer",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 5 },
        nextRunAt: null,
        activityCount: null,
      });
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-1", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines.sort((left, right) => left - right)).toEqual([
        Date.parse(streamStartedAt) + 5 * 60_000,
        now + 15 * 60_000,
      ].sort((left, right) => left - right));
      const rows = await database.prepare("SELECT timer_id, next_run_at FROM timers WHERE channel_id = ? ORDER BY timer_id")
        .bind(channelId).all<{ timer_id: string; next_run_at: string | null }>();
      expect(rows.results.map((row) => row.next_run_at)).not.toContain(null);
    });

    it("does not touch a timer that is already armed for this session", async () => {
      await insertChannel();
      const armedAt = now + 30 * 60_000;
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15 },
        nextRunAt: armedAt,
        activityCount: null,
      });
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, { streamState: () => Promise.resolve("online") });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([]);
      expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind("interval-timer").first())
        .toEqual({ next_run_at: new Date(armedAt).toISOString() });
    });

    it("rearms a timer whose stored stream id already matches the current stream but whose next_run_at is null", async () => {
      await insertChannel();
      // An edit or a disable/enable cycle can leave a stream id sitting next
      // to a null next_run_at; a matching id alone must not read as armed.
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15 },
        nextRunAt: null,
        activityCount: null,
      });
      await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", "interval-timer").run();
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-1", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([now + 15 * 60_000]);
      expect(await database.prepare("SELECT next_run_at, next_run_stream_id FROM timers WHERE timer_id = ?")
        .bind("interval-timer").first()).toEqual({
          next_run_at: new Date(now + 15 * 60_000).toISOString(),
          next_run_stream_id: "stream-1",
        });
    });

    it("rearms an interval timer whose schedule belongs to a previous stream and resets its chat baseline", async () => {
      await insertChannel();
      // Before this stream's own start: this deadline and baseline can only
      // be leftovers from a previous stream that the module missed both the
      // offline and online notifications for.
      const staleDeadline = Date.parse(streamStartedAt) - 8 * 60_000;
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15, minimumMessages: 3 },
        nextRunAt: staleDeadline,
        activityCount: 50,
      });
      const deadlines: number[] = [];
      const context = contextFor(() => 99, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([now + 15 * 60_000]);
      expect(await database.prepare("SELECT next_run_at, last_chat_activity_count FROM timers WHERE timer_id = ?")
        .bind("interval-timer").first())
        .toEqual({ next_run_at: new Date(now + 15 * 60_000).toISOString(), last_chat_activity_count: 99 });
    });

    it("rearms an interval timer whose stale deadline falls after the new stream's start (short inter-stream gap)", async () => {
      await insertChannel();
      // After this stream's own start: a start-time comparison alone would
      // call this "already armed for this stream", even though the stored
      // stream id shows it is a leftover from the previous one.
      const staleDeadline = Date.parse(streamStartedAt) + 2 * 60_000;
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15, minimumMessages: 3 },
        nextRunAt: staleDeadline,
        activityCount: 50,
      });
      await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", "interval-timer").run();
      const deadlines: number[] = [];
      const context = contextFor(() => 99, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([now + 15 * 60_000]);
      expect(await database.prepare(
        "SELECT next_run_at, next_run_stream_id, last_chat_activity_count FROM timers WHERE timer_id = ?",
      ).bind("interval-timer").first()).toEqual({
        next_run_at: new Date(now + 15 * 60_000).toISOString(),
        next_run_stream_id: "stream-2",
        last_chat_activity_count: 99,
      });
    });

    it("rearms a stream-start timer whose stale deadline falls after the new stream's start (short inter-stream gap)", async () => {
      await insertChannel();
      const staleDeadline = Date.parse(streamStartedAt) + 1 * 60_000;
      await insertTimer({
        id: "stream-start-timer",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 5 },
        nextRunAt: staleDeadline,
        activityCount: null,
      });
      await database.prepare("UPDATE timers SET next_run_stream_id = ? WHERE timer_id = ?").bind("stream-1", "stream-start-timer").run();
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      const expectedDeadline = Date.parse(streamStartedAt) + 5 * 60_000;
      expect(deadlines).toEqual([expectedDeadline]);
      expect(await database.prepare(
        "SELECT next_run_at, next_run_stream_id FROM timers WHERE timer_id = ?",
      ).bind("stream-start-timer").first()).toEqual({
        next_run_at: new Date(expectedDeadline).toISOString(),
        next_run_stream_id: "stream-2",
      });
    });

    it("rearms a stream-start timer whose schedule belongs to a previous stream", async () => {
      await insertChannel();
      const staleDeadline = Date.parse(streamStartedAt) - 20 * 60_000;
      await insertTimer({
        id: "stream-start-timer",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 5 },
        nextRunAt: staleDeadline,
        activityCount: null,
      });
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-2", startedAt: streamStartedAt }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      const expectedDeadline = Date.parse(streamStartedAt) + 5 * 60_000;
      expect(deadlines).toEqual([expectedDeadline]);
      expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind("stream-start-timer").first())
        .toEqual({ next_run_at: new Date(expectedDeadline).toISOString() });
    });

    it("does not arm a stream-start timer whose due time has already passed", async () => {
      await insertChannel();
      await insertTimer({
        id: "stream-start-timer",
        triggerType: "stream_start",
        trigger: { type: "stream_start", minutes: 5 },
        nextRunAt: null,
        activityCount: null,
      });
      const deadlines: number[] = [];
      // Delay went by ten minutes ago -- past the 5-minute stream-start delay.
      const context = contextFor(() => 0, [], deadlines, {
        streamState: () => Promise.resolve("online"),
        streamStartedAt: () => Promise.resolve({ streamId: "stream-1", startedAt: new Date(now - 10 * 60_000).toISOString() }),
      });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([]);
      expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind("stream-start-timer").first())
        .toEqual({ next_run_at: null });
    });

    it("does nothing while the channel is offline", async () => {
      await insertChannel();
      await insertTimer({
        id: "interval-timer",
        triggerType: "interval",
        trigger: { type: "interval", minutes: 15 },
        nextRunAt: null,
        activityCount: null,
      });
      const deadlines: number[] = [];
      const context = contextFor(() => 0, [], deadlines, { streamState: () => Promise.resolve("offline") });
      vi.useFakeTimers();
      vi.setSystemTime(now);

      await onInputsChangedOf()(context, "activation" satisfies ModuleScheduleInputChangeReason);

      expect(deadlines).toEqual([]);
      expect(await database.prepare("SELECT next_run_at FROM timers WHERE timer_id = ?").bind("interval-timer").first())
        .toEqual({ next_run_at: null });
    });
  });
});
