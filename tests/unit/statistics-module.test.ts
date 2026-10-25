import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { statisticsModule } from "../../src/modules/statistics";
import { processStatisticsEvent } from "../../src/modules/statistics/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";

const CHANNEL_ID = "statistics-channel";
const STREAM_ID = "stream-1";
const WINDOW_START = "2026-10-25T12:00:00.000Z";
const WINDOW_END = "2026-10-25T12:05:00.000Z";

const createContext = (
  database: TestD1Database,
  options: {
    state?: "online" | "offline";
    viewerCount?: number | null;
    chatters?: number | null;
    failPendingDelete?: boolean;
    failSchedule?: boolean;
  } = {},
): {
  context: ModuleAlarmContext;
  calls: { clear: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; viewer: ReturnType<typeof vi.fn>; chatters: ReturnType<typeof vi.fn> };
  pending: Map<string, unknown>;
} => {
  const pending = new Map<string, unknown>();
  let failPendingDelete = options.failPendingDelete ?? false;
  let failSchedule = options.failSchedule ?? false;
  const calls = {
    clear: vi.fn(() => Promise.resolve(undefined)),
    read: vi.fn(() => Promise.resolve({ messages: 12, emotes: 5 })),
    viewer: vi.fn(() => Promise.resolve(options.viewerCount === undefined ? 42 : options.viewerCount)),
    chatters: vi.fn(() => Promise.resolve(options.chatters === undefined ? 7 : options.chatters)),
  };
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    storage: {
      get: (key: string) => Promise.resolve(pending.get(key)),
      put: (key: string, value: unknown) => { pending.set(key, value); return Promise.resolve(); },
      delete: (key: string) => {
        if (failPendingDelete) {
          failPendingDelete = false;
          return Promise.reject(new Error("Injected pending snapshot cleanup failure."));
        }
        return Promise.resolve(pending.delete(key));
      },
    },
    schedule: vi.fn(() => {
      if (failSchedule) {
        failSchedule = false;
        return Promise.reject(new Error("Injected next-alarm scheduling failure."));
      }
      return Promise.resolve(undefined);
    }),
    clear: vi.fn(() => Promise.resolve(undefined)),
    activeChatters: { countBetween: vi.fn(() => Promise.resolve(3)) },
    statisticsChat: { readWindow: calls.read, clearWindow: calls.clear },
    fetchViewerCount: calls.viewer,
    fetchChattersTotal: calls.chatters,
    streamState: vi.fn(() => Promise.resolve(options.state ?? "online")),
    streamStartedAt: vi.fn(() => Promise.resolve({ streamId: STREAM_ID, startedAt: WINDOW_START })),
    externalFetchBudget: { claim: () => true },
    secrets: {} as ModuleAlarmContext["secrets"],
    ballots: {} as ModuleAlarmContext["ballots"],
    points: {} as ModuleAlarmContext["points"],
    channelLanguage: () => Promise.resolve("en" as const),
    secureRandomInteger: (maximumExclusive: number) => maximumExclusive - 1,
    executeTimeout: () => Promise.resolve("suppressed" as const),
    renderTemplate: (text: string) => Promise.resolve({ text }),
    publishModuleOverlayMessage: () => Promise.resolve(undefined),
    sendChat: () => Promise.resolve({ sent: false, reason: null, retryable: false, delivery: "not_attempted" as const }),
    chatActivityCount: () => Promise.resolve(0),
    resolveEventTimes: () => Promise.resolve([]),
  } as unknown as ModuleAlarmContext;
  return { context, calls, pending };
};

const windowAlarm = () => {
  const registration = statisticsModule.alarms?.find(({ key }) => key === "window");
  if (registration === undefined) throw new Error("Statistics window alarm is not registered.");
  return registration;
};

const insertLiveState = async (target: TestD1Database): Promise<void> => {
  await writeEventSubStreamState(
    target as unknown as D1Database,
    CHANNEL_ID,
    "online",
    WINDOW_START,
    WINDOW_START,
    STREAM_ID,
  );
};

describe("statistics window alarm", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("writes one aggregate row and schedules the next live window", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    const { context, calls } = createContext(database);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      `SELECT stream_id, window_start, window_seconds, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ? AND window_start = ?`,
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({
      stream_id: STREAM_ID,
      window_start: WINDOW_START,
      window_seconds: 300,
      messages: 12,
      emotes: 5,
      viewer_count: 42,
      chatters: 7,
      active_chatters: 3,
    });
    expect(calls.clear).toHaveBeenCalledWith(WINDOW_START);
    expect(context.schedule).toHaveBeenCalledWith("window", Date.parse(WINDOW_END) + 300_000, undefined, undefined);
  });

  it("reuses the pending snapshot when a post-upsert cleanup fails", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    const { context, calls } = createContext(database, { failPendingDelete: true });

    await expect(windowAlarm().handle(context, "window", Date.parse(WINDOW_END))).rejects.toThrow("Injected pending snapshot");
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({ count: 1 });
    expect(calls.read).toHaveBeenCalledTimes(1);
    expect(calls.viewer).toHaveBeenCalledTimes(1);
    expect(calls.chatters).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed row unchanged when scheduling the next alarm fails", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    const { context, calls } = createContext(database, { failSchedule: true });

    await expect(windowAlarm().handle(context, "window", Date.parse(WINDOW_END))).rejects.toThrow("Injected next-alarm scheduling failure.");
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      `SELECT messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ? AND window_start = ?`,
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({
      messages: 12,
      emotes: 5,
      viewer_count: 42,
      chatters: 7,
      active_chatters: 3,
    });
    expect(calls.read).toHaveBeenCalledTimes(1);
    expect(calls.viewer).toHaveBeenCalledTimes(1);
    expect(calls.chatters).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or write while offline", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const { context, calls } = createContext(database, { state: "offline" });

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_statistics").first())
      .resolves.toEqual({ count: 0 });
    expect(calls.viewer).not.toHaveBeenCalled();
    expect(calls.chatters).not.toHaveBeenCalled();
    expect(context.clear).toHaveBeenCalledWith("window");
  });

  it("writes final partial windows without external counts and keeps unavailable sources null", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const { context, calls } = createContext(database, { viewerCount: null, chatters: null });
    const endedAt = "2026-10-25T12:02:17.000Z";

    await windowAlarm().handle(context, "offline-window", Date.parse(endedAt), undefined, {
      kind: "offline-window",
      streamId: STREAM_ID,
      streamStartedAt: WINDOW_START,
      windowStart: WINDOW_START,
      windowEnd: endedAt,
    });

    await expect(database.prepare(
      `SELECT window_seconds, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ? AND window_start = ?`,
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({
      window_seconds: 137,
      messages: 12,
      emotes: 5,
      viewer_count: null,
      chatters: null,
      active_chatters: 3,
    });
    expect(calls.viewer).not.toHaveBeenCalled();
    expect(calls.chatters).not.toHaveBeenCalled();
  });

  it("flushes the final window from stream.offline before clearing chatter tracking", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const alarm = createContext(database);
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "offline-event",
      payload: {},
      settings: {},
      receivedAt: "2026-10-25T12:02:17.000Z",
      eventSubTimestamp: "2026-10-25T12:02:17.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
      getAlarmDeadline: vi.fn(() => Promise.resolve(Date.parse(WINDOW_END))),
      scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
      clearAlarm: vi.fn(() => Promise.resolve(undefined)),
      runModuleAlarm: vi.fn(async (_handlerKey: string, alarmKey: string, invocation?: unknown) =>
        await windowAlarm().handle(alarm.context, alarmKey, Date.parse(WINDOW_END), undefined, invocation)),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    await expect(database.prepare(
      `SELECT window_seconds, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ? AND window_start = ?`,
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({
      window_seconds: 137,
      messages: 12,
      emotes: 5,
      viewer_count: null,
      chatters: null,
      active_chatters: 3,
    });
    expect(context.runModuleAlarm).toHaveBeenCalledTimes(1);
    expect(context.clearAlarm).toHaveBeenCalledWith("window");
    expect(alarm.calls.viewer).not.toHaveBeenCalled();
    expect(alarm.calls.chatters).not.toHaveBeenCalled();
  });

  it("flushes every overdue window from stream start when the scheduled alarm is missing", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const alarm = createContext(database);
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "offline-event-without-alarm",
      payload: {},
      settings: {},
      receivedAt: "2026-10-25T12:07:00.000Z",
      eventSubTimestamp: "2026-10-25T12:07:00.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      streamStateTransitionAccepted: true,
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
      getAlarmDeadline: vi.fn(() => Promise.resolve(null)),
      clearAlarm: vi.fn(() => Promise.resolve(undefined)),
      runModuleAlarm: vi.fn(async (_handlerKey: string, alarmKey: string, invocation?: unknown) =>
        await windowAlarm().handle(alarm.context, alarmKey, Date.parse(WINDOW_END), undefined, invocation)),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    await expect(database.prepare(
      "SELECT window_start, window_seconds FROM channel_statistics WHERE channel_id = ? ORDER BY window_start",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [
      { window_start: WINDOW_START, window_seconds: 300 },
      { window_start: "2026-10-25T12:05:00.000Z", window_seconds: 120 },
    ] });
    expect(context.runModuleAlarm).toHaveBeenCalledTimes(2);
    expect(alarm.calls.viewer).not.toHaveBeenCalled();
    expect(alarm.calls.chatters).not.toHaveBeenCalled();
  });

  it("covers only the live seconds of the partial first window", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const startedAt = "2026-10-25T12:02:30.000Z";
    await writeEventSubStreamState(database as unknown as D1Database, CHANNEL_ID, "online", startedAt, startedAt, STREAM_ID);
    const { context } = createContext(database);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT window_start, window_seconds FROM channel_statistics WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ window_start: WINDOW_START, window_seconds: 150 });
  });

  it("merges an offline/online flap inside one window into a single row without losing counts", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const resumedAt = "2026-10-25T12:03:00.000Z";
    await writeEventSubStreamState(database as unknown as D1Database, CHANNEL_ID, "online", resumedAt, resumedAt, "stream-2");
    const { context, calls } = createContext(database);
    const offlineAt = "2026-10-25T12:02:00.000Z";
    calls.read.mockResolvedValueOnce({ messages: 4, emotes: 1 }).mockResolvedValueOnce({ messages: 6, emotes: 2 });

    await windowAlarm().handle(context, "offline-window", Date.parse(offlineAt), undefined, {
      kind: "offline-window",
      streamId: STREAM_ID,
      streamStartedAt: WINDOW_START,
      windowStart: WINDOW_START,
      windowEnd: offlineAt,
    });
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    // A repeated delivery of the boundary alarm must not count the window again.
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      `SELECT stream_id, window_seconds, messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ?`,
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [{
      stream_id: "stream-2",
      window_seconds: 120 + 120,
      messages: 10,
      emotes: 3,
      viewer_count: 42,
      chatters: 7,
      active_chatters: null,
    }] });
    expect(calls.read).toHaveBeenCalledTimes(2);
  });

  it("flushes consecutive epoch-aligned windows as separate rows", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    const { context } = createContext(database);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END) + 300_000);

    await expect(database.prepare(
      "SELECT window_start, window_seconds FROM channel_statistics WHERE channel_id = ? ORDER BY window_start",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [
      { window_start: WINDOW_START, window_seconds: 300 },
      { window_start: WINDOW_END, window_seconds: 300 },
    ] });
  });

  it("arms the next five-minute alarm from the accepted stream start", async () => {
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.online",
      triggerId: "online-event",
      payload: { id: STREAM_ID, started_at: WINDOW_START },
      settings: {},
      receivedAt: "2026-10-25T12:07:00.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      streamStateTransitionAccepted: true,
      streamStateTransitionGeneration: 9,
      scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    expect(context.scheduleAlarm).toHaveBeenCalledWith("window", "window", Date.parse(WINDOW_END), undefined, 9);
  });

  it("arms the first alarm at the next UTC boundary after a mid-window stream start", async () => {
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.online",
      triggerId: "online-event-mid-window",
      payload: { id: STREAM_ID, started_at: "2026-10-25T12:02:30.000Z" },
      settings: {},
      receivedAt: "2026-10-25T12:02:31.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      streamStateTransitionAccepted: true,
      scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    expect(context.scheduleAlarm).toHaveBeenCalledWith("window", "window", Date.parse(WINDOW_END), undefined, undefined);
  });
});
