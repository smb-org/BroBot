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
const RETENTION_MS = 60 * 60_000;

interface WindowState {
  streamId: string | null;
  windowStart: string;
  messages: number;
  emotes: number;
  viewerCount: number | null;
  chatters: number | null;
  activeChatters: number | null;
  metricsSampled: boolean;
  activeChattersSampled: boolean;
  revision: number;
  dirty: boolean;
  complete: boolean;
}

const createStatisticsChat = (initial: WindowState[] = []) => {
  const windows = new Map(initial.map((window) => [window.windowStart, { ...window }]));
  const calls = {
    advance: vi.fn((boundary: number, streamIsOnline: boolean, streamId: string | null) => {
      const windowStart = new Date(boundary - 300_000).toISOString();
      if (streamIsOnline && !windows.has(windowStart)) {
        windows.set(windowStart, windowState({ streamId, messages: 0, emotes: 0 }));
      }
      const window = windows.get(windowStart);
      if (window !== undefined) {
        window.complete = true;
        if (streamIsOnline && !window.activeChattersSampled) {
          window.activeChatters = 3;
          window.activeChattersSampled = true;
          window.revision += 1;
          window.dirty = true;
        }
      }
      return Promise.resolve();
    }),
    listDirty: vi.fn(() => Promise.resolve([...windows.values()]
      .filter((window) => window.dirty && window.complete)
      .map((window) => window.windowStart))),
    read: vi.fn((windowStart: string) => {
      const window = windows.get(windowStart);
      return Promise.resolve(window === undefined ? null : { ...window });
    }),
    saveMetrics: vi.fn((windowStart: string, viewerCount: number | null, chatters: number | null) => {
      const window = windows.get(windowStart);
      if (window === undefined || window.metricsSampled) return Promise.resolve();
      window.viewerCount = viewerCount;
      window.chatters = chatters;
      window.metricsSampled = true;
      window.revision += 1;
      window.dirty = true;
      return Promise.resolve();
    }),
    markClean: vi.fn((windowStart: string, revision: number) => {
      const window = windows.get(windowStart);
      if (window !== undefined && window.revision === revision) window.dirty = false;
      return Promise.resolve();
    }),
    prune: vi.fn((now: number) => {
      for (const windowStart of windows.keys()) {
        if (Date.parse(windowStart) + 300_000 + RETENTION_MS < now) windows.delete(windowStart);
      }
      return Promise.resolve();
    }),
    hasWindows: vi.fn(() => Promise.resolve(windows.size > 0)),
  };
  return {
    windows,
    calls,
    api: {
      advanceToBoundary: calls.advance,
      listDirtyCompletedWindows: calls.listDirty,
      readWindow: calls.read,
      saveWindowMetrics: calls.saveMetrics,
      markWindowClean: calls.markClean,
      pruneExpiredWindows: calls.prune,
      hasWindows: calls.hasWindows,
    },
    recordChat(windowStart: string, messages: number, emotes: number): void {
      const window = windows.get(windowStart);
      if (window === undefined) throw new Error("Test window is missing.");
      window.messages += messages;
      window.emotes += emotes;
      window.revision += 1;
      window.dirty = true;
    },
  };
};

const createContext = (
  database: TestD1Database,
  chat: ReturnType<typeof createStatisticsChat>,
  options: { state?: "online" | "offline"; viewerCount?: number | null; chatters?: number | null } = {},
): {
  context: ModuleAlarmContext;
  calls: {
    schedule: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    viewer: ReturnType<typeof vi.fn>;
    chatters: ReturnType<typeof vi.fn>;
  };
} => {
  const calls = {
    schedule: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    viewer: vi.fn(() => Promise.resolve(options.viewerCount === undefined ? 42 : options.viewerCount)),
    chatters: vi.fn(() => Promise.resolve(options.chatters === undefined ? 7 : options.chatters)),
  };
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    schedule: calls.schedule,
    clear: calls.clear,
    statisticsChat: chat.api,
    fetchViewerCount: calls.viewer,
    fetchChattersTotal: calls.chatters,
    secrets: {} as ModuleAlarmContext["secrets"],
    ballots: {} as ModuleAlarmContext["ballots"],
    points: {} as ModuleAlarmContext["points"],
    channelLanguage: () => Promise.resolve("en" as const),
    secureRandomInteger: (maximumExclusive: number) => maximumExclusive - 1,
    executeTimeout: () => Promise.resolve("suppressed" as const),
    storage: { get: () => Promise.resolve(undefined), put: () => Promise.resolve(), delete: () => Promise.resolve(false) },
    renderTemplate: (text: string) => Promise.resolve({ text }),
    publishModuleOverlayMessage: () => Promise.resolve(undefined),
    sendChat: () => Promise.resolve({ sent: false, reason: null, retryable: false, delivery: "not_attempted" as const }),
    chatActivityCount: () => Promise.resolve(0),
    resolveEventTimes: () => Promise.resolve([]),
  } as unknown as ModuleAlarmContext;
  return { context, calls };
};

const windowAlarm = () => {
  const registration = statisticsModule.alarms?.find(({ key }) => key === "window");
  if (registration === undefined) throw new Error("Statistics window alarm is not registered.");
  return registration;
};

const writeStreamState = async (
  database: TestD1Database,
  state: "online" | "offline",
  changedAt = WINDOW_START,
): Promise<void> => {
  await writeEventSubStreamState(
    database as unknown as D1Database,
    CHANNEL_ID,
    state,
    changedAt,
    state === "online" ? WINDOW_START : null,
    state === "online" ? STREAM_ID : null,
  );
};

const windowState = (overrides: Partial<WindowState> = {}): WindowState => ({
  streamId: STREAM_ID,
  windowStart: WINDOW_START,
  messages: 12,
  emotes: 5,
  viewerCount: 42,
  chatters: 7,
  activeChatters: 3,
  metricsSampled: true,
  activeChattersSampled: true,
  revision: 2,
  dirty: true,
  complete: true,
  ...overrides,
});

const failFirstStatisticsWrite = (database: TestD1Database): { DB: D1Database; bindings: unknown[][] } => {
  let shouldFail = true;
  const bindings: unknown[][] = [];
  return {
    bindings,
    DB: {
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        if (!sql.includes("INSERT INTO channel_statistics")) return statement;
        let wrappedBindings: unknown[] = [];
        const wrapped = {
          bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
            wrappedBindings = values;
            statement.bind(...values);
            return wrapped;
          },
          run: () => {
            bindings.push([...wrappedBindings]);
            if (shouldFail) {
              shouldFail = false;
              return Promise.reject(new Error("Injected temporary D1 failure."));
            }
            return statement.run();
          },
        };
        return wrapped;
      },
    } as unknown as D1Database,
  };
};

describe("statistics window alarm", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
    vi.useRealTimers();
  });

  it("retries a failed D1 write with the same absolute totals and stored boundary samples", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "online");
    const chat = createStatisticsChat([windowState()]);
    const failing = failFirstStatisticsWrite(database);
    const { context, calls } = createContext(database, chat);
    context.DB = failing.DB;

    await expect(windowAlarm().handle(context, "window", Date.parse(WINDOW_END)))
      .rejects.toThrow("Injected temporary D1 failure.");
    expect(chat.windows.get(WINDOW_START)?.dirty).toBe(true);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    expect(failing.bindings).toHaveLength(2);
    expect(failing.bindings[0]).toEqual(failing.bindings[1]);
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
    expect(calls.viewer).not.toHaveBeenCalled();
    expect(calls.chatters).not.toHaveBeenCalled();
    expect(chat.windows.get(WINDOW_START)?.dirty).toBe(false);
  });

  it("rewrites an already-written window with a late absolute increment", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "online");
    const chat = createStatisticsChat([windowState({ messages: 10, emotes: 4 })]);
    const { context } = createContext(database, chat);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    const firstWrite = await database.prepare(
      "SELECT messages FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first<{ messages: number }>();

    chat.recordChat(WINDOW_START, 2, 1);
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    const secondWrite = await database.prepare(
      "SELECT messages FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first<{ messages: number }>();

    expect([firstWrite?.messages, secondWrite?.messages]).toEqual([10, 12]);
  });

  it("keeps the window dirty when a late increment lands during the D1 write", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "online");
    const chat = createStatisticsChat([windowState({ messages: 10, emotes: 4 })]);
    const { context } = createContext(database, chat);
    let injected = false;
    const activeDatabase = database;
    context.DB = {
      prepare: (sql: string) => {
        const statement = activeDatabase.prepare(sql);
        if (!sql.includes("INSERT INTO channel_statistics")) return statement;
        const wrapped = {
          bind: (...bound: Parameters<TestPreparedStatement["bind"]>) => {
            statement.bind(...bound);
            return wrapped;
          },
          run: async () => {
            const result = await statement.run();
            if (!injected) {
              injected = true;
              chat.recordChat(WINDOW_START, 2, 1);
            }
            return result;
          },
        };
        return wrapped;
      },
    } as unknown as D1Database;

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    expect(chat.windows.get(WINDOW_START)?.dirty).toBe(true);
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT messages FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({ messages: 12 });
    expect(chat.windows.get(WINDOW_START)?.dirty).toBe(false);
  });

  it("never lowers the stored absolute message total with a stale retry", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "online");
    await database.prepare(
      `INSERT INTO channel_statistics
         (channel_id, stream_id, window_start, messages, emotes)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, STREAM_ID, WINDOW_START, 15, 6).run();
    const chat = createStatisticsChat([windowState({ messages: 10, emotes: 4 })]);
    const { context } = createContext(database, chat);

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT messages FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({ messages: 15 });
  });

  it("writes an offline window on the next alarm without sampling its boundary metrics", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", "2026-10-25T12:02:17.000Z");
    const chat = createStatisticsChat([windowState({
      viewerCount: null,
      chatters: null,
      activeChatters: null,
      activeChattersSampled: false,
      metricsSampled: false,
    })]);
    const { context, calls } = createContext(database, chat, { state: "offline" });

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      `SELECT messages, emotes, viewer_count, chatters, active_chatters
         FROM channel_statistics WHERE channel_id = ? AND window_start = ?`,
    ).bind(CHANNEL_ID, WINDOW_START).first()).resolves.toEqual({
      messages: 12,
      emotes: 5,
      viewer_count: null,
      chatters: null,
      active_chatters: null,
    });
    expect(calls.viewer).not.toHaveBeenCalled();
    expect(calls.chatters).not.toHaveBeenCalled();
    expect(calls.schedule).toHaveBeenCalledWith("window", Date.parse(WINDOW_END) + 300_000);
  });

  it("prunes an expired window after its final failed write attempt", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat([windowState({
      viewerCount: null,
      chatters: null,
      activeChatters: null,
      metricsSampled: true,
      activeChattersSampled: false,
    })]);
    const failing = failFirstStatisticsWrite(database);
    const { context } = createContext(database, chat, { state: "offline" });
    context.DB = failing.DB;
    const expiredAt = Date.parse(WINDOW_END) + RETENTION_MS + 1;
    vi.useFakeTimers();
    vi.setSystemTime(expiredAt);

    await expect(windowAlarm().handle(context, "window", expiredAt)).rejects.toThrow("Injected temporary D1 failure.");

    expect(failing.bindings).toHaveLength(1);
    expect(chat.windows.size).toBe(0);
    expect(chat.calls.prune).toHaveBeenCalledWith(expiredAt);
    await windowAlarm().handle(context, "window", expiredAt);
    expect(context.clear).toHaveBeenCalledWith("window");
  });

  it("starts the live sampler without a transition generation", async () => {
    const scheduleAlarm = vi.fn(() => Promise.resolve());
    const clearAlarm = vi.fn(() => Promise.resolve());
    const execution = {
      scheduleAlarm,
      clearAlarm,
      streamStateTransitionAccepted: true,
      getAlarmDeadline: vi.fn(() => Promise.resolve(Date.parse(WINDOW_END))),
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
    } as unknown as ModuleExecutionContext;
    const online: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.online",
      triggerId: "online",
      payload: { id: STREAM_ID, started_at: WINDOW_START },
      settings: {},
      receivedAt: WINDOW_START,
      actor: null,
      chatStatus: null,
    };
    await processStatisticsEvent(online, execution);

    expect(scheduleAlarm).toHaveBeenCalledWith("window", "window", Date.parse(WINDOW_END));
    expect(clearAlarm).not.toHaveBeenCalled();
  });
});
