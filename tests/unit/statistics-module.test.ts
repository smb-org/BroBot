import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { statisticsModule } from "../../src/modules/statistics";
import { processStatisticsEvent } from "../../src/modules/statistics/service";
import { insertChannel } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";

const CHANNEL_ID = "statistics-channel";
const STREAM_ID = "stream-1";
const WINDOW_START = "2026-10-25T12:00:00.000Z";
const WINDOW_END = "2026-10-25T12:05:00.000Z";
const offlineAlarmKey = (streamId: string, streamStartedAt: string, endedAt: string, generation = 0): string => {
  const startMs = Date.parse(streamStartedAt);
  return `offline:${encodeURIComponent(streamId)}:${String(startMs)}:${String(Math.floor(startMs / 300_000) * 300_000)}:${String(Date.parse(endedAt))}:${String(generation)}`;
};

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
  calls: {
    clear: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    viewer: ReturnType<typeof vi.fn>;
    chatters: ReturnType<typeof vi.fn>;
  };
  pending: Map<string, unknown>;
} => {
  const pending = new Map<string, unknown>();
  let failPendingDelete = options.failPendingDelete ?? false;
  let failSchedule = options.failSchedule ?? false;
  const flushedWindows = new Set<string>();
  const calls = {
    clear: vi.fn((windowStart: string) => { void windowStart; return Promise.resolve(undefined); }),
    list: vi.fn((prefix: string, limit: number, startAfter?: string) => {
      const keys = [...pending.keys()]
        .filter((key) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit);
      return Promise.resolve(new Map(keys.map((key) => [key, pending.get(key)])));
    }),
    read: vi.fn((windowStart: string) => { void windowStart; return Promise.resolve({ messages: 12, emotes: 5 }); }),
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
      list: calls.list,
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
    statisticsChat: {
      beginWindowFlush: vi.fn(async (windowStart: string) => {
        const chat = await calls.read(windowStart);
        return flushedWindows.has(windowStart)
          ? { messages: 0, emotes: 0, activeChatters: 3, hasNew: false }
          : { ...chat, activeChatters: 3, hasNew: chat.messages > 0 };
      }),
      finishWindowFlush: vi.fn(async (windowStart: string) => {
        flushedWindows.add(windowStart);
        await calls.clear(windowStart);
      }),
      listDirtyWindowsBefore: vi.fn(() => Promise.resolve([])),
      pruneRetiredWindowsBefore: vi.fn(() => Promise.resolve()),
      clearWindowChattersThrough: vi.fn(() => Promise.resolve()),
    },
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
    vi.useRealTimers();
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

  it("reconciles bounded dirty windows and prunes retired counters after each flush", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    const oldWindow = "2026-10-25T11:55:00.000Z";
    const { context } = createContext(database);
    const statisticsChat = context.statisticsChat;
    if (statisticsChat === undefined) throw new Error("Statistics chat context is missing.");
    vi.mocked(statisticsChat.listDirtyWindowsBefore).mockResolvedValueOnce([oldWindow]);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT window_start, messages FROM channel_statistics WHERE channel_id = ? ORDER BY window_start",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [
      { window_start: oldWindow, messages: 12 },
      { window_start: WINDOW_START, messages: 12 },
    ] });
    expect(statisticsChat.listDirtyWindowsBefore).toHaveBeenCalledWith(WINDOW_START, 24);
    expect(statisticsChat.pruneRetiredWindowsBefore).toHaveBeenCalledWith(
      expect.any(String),
      100,
    );
  });

  it("prunes retired per-window carry snapshots with a bounded storage scan", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(WINDOW_END) + 15 * 60_000);
    const oldWindow = "2026-10-25T11:00:00.000Z";
    const { context, pending, calls } = createContext(database);
    pending.set(`last:${String(Date.parse(oldWindow))}`, {
      streamId: STREAM_ID,
      windowStart: oldWindow,
      windowEnd: "2026-10-25T11:05:00.000Z",
      windowSeconds: 300,
      messages: 3,
      emotes: 2,
      viewerCount: null,
      chatters: null,
      activeChatters: 1,
    });

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    expect(pending.has(`last:${String(Date.parse(oldWindow))}`)).toBe(false);
    expect(pending.has(`last:${String(Date.parse(WINDOW_START))}`)).toBe(true);
    expect(calls.list).toHaveBeenCalledWith("last:", 100, undefined);
  });

  it("reconciles one alarm for a channel that is already online", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLiveState(database);
    let deadline: number | null = null;
    let generation: number | null = null;
    const { context } = createContext(database);
    context.getAlarmDeadline = vi.fn(() => Promise.resolve(deadline));
    context.getAlarmPlan = vi.fn(() => Promise.resolve({
      identity: null,
      planSequence: null,
      streamGeneration: generation,
    }));
    context.schedule = vi.fn((
      _key: string,
      scheduledDeadline: number,
      _ownerRevision?: number,
      scheduledGeneration?: number | null,
    ): Promise<void> => {
      deadline = scheduledDeadline;
      generation = typeof scheduledGeneration === "number" ? scheduledGeneration : null;
      return Promise.resolve();
    });
    const reconcile = windowAlarm().onScheduleInputsChanged;
    if (reconcile === undefined) throw new Error("Statistics alarm reconciliation is not registered.");
    const stream = await database.prepare(
      "SELECT transition_generation FROM channel_stream_state WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ transition_generation: number }>();

    await reconcile(context, "stream_state");
    await reconcile(context, "stream_state");

    expect(context.schedule).toHaveBeenCalledOnce();
    expect(context.schedule).toHaveBeenCalledWith(
      "window",
      Date.parse(WINDOW_END),
      undefined,
      stream?.transition_generation,
    );
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
    expect(calls.read).toHaveBeenCalledTimes(2);
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
    expect(calls.read).toHaveBeenCalledTimes(2);
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
    expect(context.clear).toHaveBeenCalledWith("window", undefined, undefined);
  });

  it("writes final partial windows without external counts and keeps unavailable sources null", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const { context, calls } = createContext(database, { viewerCount: null, chatters: null });
    const endedAt = "2026-10-25T12:02:17.000Z";

    await windowAlarm().handle(context, offlineAlarmKey(STREAM_ID, WINDOW_START, endedAt), Date.parse(endedAt));

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

  it("durably schedules the final window before clearing only its stream alarm", async () => {
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
    const endedAt = event.eventSubTimestamp ?? event.receivedAt;
    const context = {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamStateTransitionGeneration: 2,
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
      getAlarmDeadline: vi.fn(() => Promise.resolve(Date.parse(WINDOW_END))),
      scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
      clearAlarm: vi.fn(() => Promise.resolve(undefined)),
      runModuleAlarm: vi.fn(async (_handlerKey: string, alarmKey: string, invocation?: unknown) =>
        await windowAlarm().handle(alarm.context, alarmKey, Date.parse(WINDOW_END), undefined, invocation)),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    expect(context.scheduleAlarm).toHaveBeenCalledOnce();
    expect(context.scheduleAlarm).toHaveBeenCalledWith(
      "window",
      expect.stringMatching(/^offline:/u),
      expect.any(Number),
      undefined,
      null,
    );
    expect(context.runModuleAlarm).not.toHaveBeenCalled();
    expect(context.clearAlarm).toHaveBeenCalledWith("window", undefined, 2);

    const alarmKey = vi.mocked(context.scheduleAlarm).mock.calls[0]?.[1];
    if (alarmKey === undefined) throw new Error("Offline statistics alarm key was not scheduled.");
    await windowAlarm().handle(alarm.context, alarmKey, Date.parse(endedAt));

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
    expect(alarm.calls.viewer).not.toHaveBeenCalled();
    expect(alarm.calls.chatters).not.toHaveBeenCalled();
  });

  it("retries a durably scheduled offline flush after a transient D1 failure", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    let failFirstWrite = true;
    const retryableDatabase = {
      prepare: (sql: string) => {
        const statement = database?.prepare(sql);
        if (statement === undefined || !sql.includes("INSERT INTO channel_statistics")) return statement;
        const wrapped = {
          bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
            statement.bind(...values);
            return wrapped;
          },
          run: () => {
            if (failFirstWrite) {
              failFirstWrite = false;
              return Promise.reject(new Error("Injected temporary D1 failure."));
            }
            return statement.run();
          },
        };
        return wrapped;
      },
    } as unknown as D1Database;
    const alarm = createContext(retryableDatabase as unknown as TestD1Database);
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "offline-event-retry",
      payload: {},
      settings: {},
      receivedAt: "2026-10-25T12:02:17.000Z",
      eventSubTimestamp: "2026-10-25T12:02:17.000Z",
      actor: null,
      chatStatus: null,
    };
    const execution = {
      streamStateTransitionAccepted: true,
      streamStateTransitionGeneration: 7,
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
      getAlarmDeadline: vi.fn(() => Promise.resolve(null)),
      scheduleAlarm: vi.fn(() => Promise.resolve()),
      clearAlarm: vi.fn(() => Promise.resolve()),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, execution);
    const alarmKey = vi.mocked(execution.scheduleAlarm).mock.calls[0]?.[1];
    if (alarmKey === undefined) throw new Error("Offline statistics alarm was not scheduled.");
    await expect(windowAlarm().handle(alarm.context, alarmKey, Date.parse(event.receivedAt)))
      .rejects.toThrow("Injected temporary D1 failure.");
    await windowAlarm().handle(alarm.context, alarmKey, Date.parse(event.receivedAt));

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({ count: 1 });
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
      scheduleAlarm: vi.fn(() => Promise.resolve(undefined)),
      clearAlarm: vi.fn(() => Promise.resolve(undefined)),
      runModuleAlarm: vi.fn(),
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(event, context);

    const scheduledAlarmKey = vi.mocked(context.scheduleAlarm).mock.calls[0]?.[1];
    if (scheduledAlarmKey === undefined) throw new Error("Offline statistics alarm was not scheduled.");
    await windowAlarm().handle(alarm.context, scheduledAlarmKey, Date.parse("2026-10-25T12:07:00.000Z"));

    await expect(database.prepare(
      "SELECT window_start, window_seconds FROM channel_statistics WHERE channel_id = ? ORDER BY window_start",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [
      { window_start: WINDOW_START, window_seconds: 300 },
      { window_start: "2026-10-25T12:05:00.000Z", window_seconds: 120 },
    ] });
    expect(context.runModuleAlarm).not.toHaveBeenCalled();
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

    const existingStatisticsChat = context.statisticsChat;
    if (existingStatisticsChat === undefined) throw new Error("Statistics chat context is missing.");
    context.statisticsChat = {
      finishWindowFlush: existingStatisticsChat.finishWindowFlush,
      listDirtyWindowsBefore: existingStatisticsChat.listDirtyWindowsBefore,
      pruneRetiredWindowsBefore: existingStatisticsChat.pruneRetiredWindowsBefore,
      clearWindowChattersThrough: existingStatisticsChat.clearWindowChattersThrough,
      beginWindowFlush: vi.fn()
        .mockResolvedValueOnce({ messages: 4, emotes: 1, activeChatters: 2, hasNew: true })
        .mockResolvedValueOnce({ messages: 6, emotes: 2, activeChatters: 3, hasNew: true })
        .mockResolvedValueOnce({ messages: 0, emotes: 0, activeChatters: 3, hasNew: false }),
    };
    await windowAlarm().handle(context, offlineAlarmKey(STREAM_ID, WINDOW_START, offlineAt), Date.parse(offlineAt));
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
      active_chatters: 3,
    }] });
    expect(context.statisticsChat.beginWindowFlush).toHaveBeenCalledTimes(3);
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
