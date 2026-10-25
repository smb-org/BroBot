import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { statisticsModule } from "../../src/modules/statistics";
import { processStatisticsEvent, reconcileStatisticsSchedule } from "../../src/modules/statistics/service";
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
  const wordStreams = new Map<string, {
    words: Array<{ word: string; count: number; lastSeenAt: string }>;
    endedAt: string | null;
    expiresAt: number;
    batch?: number;
    lastIncrementAt?: number;
  }>();
  const calls = {
    flushWordCounts: vi.fn(() => Promise.resolve()),
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
    markWordStreamEnded: vi.fn((streamId: string, endedAt: string) => {
      const stream = wordStreams.get(streamId);
      if (stream !== undefined && stream.endedAt === null) {
        stream.endedAt = endedAt;
        stream.expiresAt = Date.parse(endedAt) + 24 * 60 * 60_000;
      }
      return Promise.resolve();
    }),
    reconcileWordStreams: vi.fn((streamState: "online" | "offline" | "unknown", streamId: string | null, observedAt: number) => {
      for (const [id, stream] of wordStreams) {
        if (stream.endedAt !== null) continue;
        if (streamState === "unknown") continue;
        if (streamState === "offline" || streamId !== null && id !== streamId) {
          stream.endedAt = new Date(observedAt).toISOString();
          stream.expiresAt = observedAt + 24 * 60 * 60_000;
        } else {
          stream.expiresAt = observedAt + 24 * 60 * 60_000;
        }
      }
      return Promise.resolve();
    }),
    listMergeableWordBuckets: vi.fn((streamState: "online" | "offline" | "unknown", streamId: string | null, idleBefore: number) =>
      Promise.resolve([...wordStreams].filter(([id, stream]) =>
        (streamState === "offline" || streamState === "online" && id !== streamId) &&
        (stream.lastIncrementAt ?? Date.parse(WINDOW_END) - 15 * 60_000) <= idleBefore)
        .map(([id, stream]) => ({ streamId: id, batch: stream.batch ?? 1 })))),
    prepareWordBucketForMerge: vi.fn((bucket: { streamId: string; batch: number }, streamState: "online" | "offline" | "unknown",
      streamId: string | null, idleBefore: number) => {
      const stream = wordStreams.get(bucket.streamId);
      if (stream === undefined || streamState !== "offline" && bucket.streamId === streamId ||
          (stream.lastIncrementAt ?? Date.parse(WINDOW_END) - 15 * 60_000) > idleBefore) return Promise.resolve([]);
      if ((stream.batch ?? 1) === bucket.batch) stream.batch = bucket.batch + 1;
      return Promise.resolve(stream.words.map((word) => ({ ...word })));
    }),
    deleteWordBucket: vi.fn((bucket: { streamId: string; batch: number }) => {
      const stream = wordStreams.get(bucket.streamId);
      if (stream !== undefined) stream.words = [];
      return Promise.resolve();
    }),
    pruneExpiredWordStreams: vi.fn((now: number) => {
      for (const [streamId, stream] of wordStreams) {
        if (stream.expiresAt <= now) wordStreams.delete(streamId);
      }
      return Promise.resolve();
    }),
    hasWordStreams: vi.fn(() => Promise.resolve(wordStreams.size > 0)),
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
      flushWordCounts: calls.flushWordCounts,
      markWordStreamEnded: calls.markWordStreamEnded,
      reconcileWordStreams: calls.reconcileWordStreams,
      listMergeableWordBuckets: calls.listMergeableWordBuckets,
      prepareWordBucketForMerge: calls.prepareWordBucketForMerge,
      deleteWordBucket: calls.deleteWordBucket,
      pruneExpiredWordStreams: calls.pruneExpiredWordStreams,
      hasWordStreams: calls.hasWordStreams,
    },
    wordStreams,
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

  beforeEach(() => {
    // Pruning compares window ends with the wall clock; keep the fixed test windows "just completed".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(WINDOW_END) + 1_000);
  });

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

  it("merges an idle ended bucket despite a recent clean window", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat([windowState({ dirty: false })]);
    chat.wordStreams.set(STREAM_ID, {
      words: [{ word: "hallo", count: 4, lastSeenAt: WINDOW_END }],
      endedAt: WINDOW_END,
      expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000,
    });
    const { context } = createContext(database, chat);
    const batch = vi.fn((statements: TestPreparedStatement[]) => database?.batch(statements) ?? Promise.resolve([]));
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch,
    } as unknown as D1Database;

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    expect(batch).toHaveBeenCalledTimes(1);
    await expect(database.prepare(
      `SELECT total_count FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word = ?`,
    ).bind(CHANNEL_ID, "hallo").first()).resolves.toEqual({ total_count: 4 });
    expect(chat.calls.deleteWordBucket).toHaveBeenCalledWith({ streamId: STREAM_ID, batch: 1 });
    expect(chat.wordStreams.get(STREAM_ID)?.words).toEqual([]);
  });

  it("keeps the bucket when D1 reports the stream live between the state read and the merge", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat([windowState({ dirty: false })]);
    chat.wordStreams.set(STREAM_ID, {
      words: [{ word: "livewords", count: 4, lastSeenAt: WINDOW_END }],
      endedAt: WINDOW_END,
      expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000,
    });
    const { context } = createContext(database, chat);
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch: async (statements: TestPreparedStatement[]) => {
        // The stream goes live after the alarm read the channel as offline.
        await database?.prepare(
          "UPDATE channel_stream_state SET state = 'online', stream_id = ?, started_at = ? WHERE channel_id = ?",
        ).bind(STREAM_ID, WINDOW_START, CHANNEL_ID).run();
        return database?.batch(statements) ?? [];
      },
    } as unknown as D1Database;

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_streams WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    expect(chat.calls.deleteWordBucket).not.toHaveBeenCalled();
    expect(chat.wordStreams.get(STREAM_ID)?.words).toHaveLength(1);
  });

  it("keeps the bucket when D1 turns online without a stream id between the state read and the merge", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat([windowState({ dirty: false })]);
    chat.wordStreams.set(STREAM_ID, {
      words: [{ word: "unknownstream", count: 4, lastSeenAt: WINDOW_END }],
      endedAt: WINDOW_END,
      expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000,
    });
    const { context } = createContext(database, chat);
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch: async (statements: TestPreparedStatement[]) => {
        await database?.prepare(
          "UPDATE channel_stream_state SET state = 'online', stream_id = NULL, started_at = ? WHERE channel_id = ?",
        ).bind(WINDOW_START, CHANNEL_ID).run();
        return database?.batch(statements) ?? [];
      },
    } as unknown as D1Database;

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_streams WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    expect(chat.calls.deleteWordBucket).not.toHaveBeenCalled();
    expect(chat.wordStreams.get(STREAM_ID)?.words).toHaveLength(1);
  });

  it("does not let a later batch overtake a batch refused because the stream is live", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat();
    chat.wordStreams.set(STREAM_ID, { words: [], endedAt: WINDOW_END, expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000 });
    const buckets = [{ streamId: STREAM_ID, batch: 1 }, { streamId: STREAM_ID, batch: 2 }];
    chat.calls.listMergeableWordBuckets.mockResolvedValue(buckets);
    chat.calls.prepareWordBucketForMerge.mockImplementation((bucket) => Promise.resolve([{
      word: bucket.batch === 1 ? "firstword" : "laterword",
      count: 1,
      lastSeenAt: WINDOW_END,
    }]));
    const { context } = createContext(database, chat);
    let batchCalls = 0;
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch: async (statements: TestPreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 1) {
          // D1 reports the stream live right when the first batch is written.
          await database?.prepare(
            "UPDATE channel_stream_state SET state = 'online', stream_id = ?, started_at = ? WHERE channel_id = ?",
          ).bind(STREAM_ID, WINDOW_START, CHANNEL_ID).run();
        }
        return database?.batch(statements) ?? [];
      },
    } as unknown as D1Database;

    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END));

    // Batch 1 was refused, so batch 2 is not even attempted in this run.
    expect(batchCalls).toBe(1);
    expect(chat.calls.prepareWordBucketForMerge).toHaveBeenCalledTimes(1);
    expect(chat.calls.deleteWordBucket).not.toHaveBeenCalled();

    await database.prepare(
      "UPDATE channel_stream_state SET state = 'offline', stream_id = NULL, started_at = NULL WHERE channel_id = ?",
    ).bind(CHANNEL_ID).run();
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END) + 300_000);

    expect(chat.calls.deleteWordBucket.mock.calls.map(([bucket]) => bucket.batch)).toEqual([1, 2]);
    await expect(database.prepare(
      "SELECT word FROM channel_word_frequency_baseline WHERE channel_id = ? ORDER BY word",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [{ word: "firstword" }, { word: "laterword" }] });
  });

  it("does not merge a later batch while an earlier batch for that stream is retrying", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat();
    chat.wordStreams.set(STREAM_ID, { words: [], endedAt: WINDOW_END, expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000 });
    const buckets = [{ streamId: STREAM_ID, batch: 1 }, { streamId: STREAM_ID, batch: 2 }];
    chat.calls.listMergeableWordBuckets.mockResolvedValue(buckets);
    chat.calls.prepareWordBucketForMerge.mockImplementation((bucket) => Promise.resolve([{
      word: bucket.batch === 1 ? "firstword" : "laterword",
      count: 1,
      lastSeenAt: WINDOW_END,
    }]));
    const { context } = createContext(database, chat);
    let attempts = 0;
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch: () => {
        attempts += 1;
        return Promise.reject(new Error("Injected first-batch failure."));
      },
    } as unknown as D1Database;

    await expect(windowAlarm().handle(context, "window", Date.parse(WINDOW_END)))
      .rejects.toThrow("Injected first-batch failure.");

    expect(attempts).toBe(1);
    expect(chat.calls.prepareWordBucketForMerge).toHaveBeenCalledTimes(1);
    expect(chat.calls.prepareWordBucketForMerge).toHaveBeenCalledWith(buckets[0], "offline", null, expect.any(Number));
  });

  it("prunes expired word data after a failed D1 merge and keeps the existing alarm retrying meanwhile", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat();
    chat.wordStreams.set(STREAM_ID, {
      words: [{ word: "streamword", count: 2, lastSeenAt: WINDOW_END }],
      endedAt: WINDOW_END,
      expiresAt: Date.parse(WINDOW_END) + 10_000,
    });
    const { context, calls } = createContext(database, chat);
    context.DB = {
      prepare: (sql: string) => database?.prepare(sql),
      batch: () => Promise.reject(new Error("Injected word baseline D1 failure.")),
    } as unknown as D1Database;

    await expect(windowAlarm().handle(context, "window", Date.parse(WINDOW_END)))
      .rejects.toThrow("Injected word baseline D1 failure.");
    expect(chat.calls.pruneExpiredWordStreams).toHaveBeenCalledWith(Date.parse(WINDOW_END) + 1_000);
    expect(chat.wordStreams.has(STREAM_ID)).toBe(true);
    expect(calls.schedule).toHaveBeenCalledWith("window", Date.parse(WINDOW_END) + 300_000);

    vi.setSystemTime(Date.parse(WINDOW_END) + 10_001);
    await windowAlarm().handle(context, "window", Date.parse(WINDOW_END) + 10_001);

    expect(chat.calls.pruneExpiredWordStreams).toHaveBeenLastCalledWith(Date.parse(WINDOW_END) + 10_001);
    expect(chat.wordStreams.has(STREAM_ID)).toBe(false);
    expect(chat.calls.deleteWordBucket).not.toHaveBeenCalled();
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
    vi.setSystemTime(expiredAt);

    await expect(windowAlarm().handle(context, "window", expiredAt)).rejects.toThrow("Injected temporary D1 failure.");

    expect(failing.bindings).toHaveLength(1);
    expect(chat.windows.size).toBe(0);
    expect(chat.calls.prune).toHaveBeenCalledWith(expiredAt);
    await windowAlarm().handle(context, "window", expiredAt);
    // The chain ends by not rescheduling; the host retires the occurrence, the handler never clears.
    expect(context.schedule).not.toHaveBeenCalled();
    expect(context.clear).not.toHaveBeenCalled();
  });

  it("prunes expired windows even when the stream-state read keeps failing", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const chat = createStatisticsChat([windowState({ dirty: false })]);
    const { context } = createContext(database, chat);
    context.DB = {
      prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("Injected state read failure.")) }) }),
    } as unknown as D1Database;
    const expiredAt = Date.parse(WINDOW_END) + RETENTION_MS + 1;
    vi.setSystemTime(expiredAt);

    await expect(windowAlarm().handle(context, "window", expiredAt)).rejects.toThrow("Injected state read failure.");

    expect(chat.calls.prune).toHaveBeenCalledWith(expiredAt);
    expect(chat.windows.size).toBe(0);
  });

  it("leaves a newer alarm armed by stream.online while an older offline snapshot is in flight", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const chat = createStatisticsChat([]);
    const { context } = createContext(database, chat, { state: "offline" });
    // A minimal host alarm table: schedule replaces the entry, clear deletes it, and completion only
    // retires the occurrence that is still the stored entry (the revision guard of the real host).
    const alarms = new Map<string, number>([["window", Date.parse(WINDOW_END)]]);
    context.schedule = vi.fn((key: string, deadline: number) => {
      alarms.set(key, deadline);
      return Promise.resolve();
    });
    context.clear = vi.fn((key: string) => {
      alarms.delete(key);
      return Promise.resolve();
    });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    context.DB = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            await readReleased;
            return { state: "offline", stream_id: null, started_at: null };
          },
        }),
      }),
    } as unknown as D1Database;

    const running = windowAlarm().handle(context, "window", Date.parse(WINDOW_END));
    // stream.online arms the next boundary while the stale offline read is still pending.
    alarms.set("window", Date.parse(WINDOW_END) + 300_000);
    releaseRead();
    await running;
    if (alarms.get("window") === Date.parse(WINDOW_END)) alarms.delete("window");

    expect(alarms.get("window")).toBe(Date.parse(WINDOW_END) + 300_000);
    expect(context.clear).not.toHaveBeenCalled();
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

  it("marks only the accepted ending stream as ready for a baseline merge", async () => {
    const markWordStreamEnded = vi.fn(() => Promise.resolve());
    const scheduleAlarm = vi.fn(() => Promise.resolve());
    const offline: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "offline",
      payload: { id: STREAM_ID },
      settings: {},
      receivedAt: WINDOW_END,
      eventSubTimestamp: WINDOW_END,
      actor: null,
      chatStatus: null,
    };
    const execution = {
      statisticsChat: { markWordStreamEnded },
      scheduleAlarm,
      streamStateTransitionAccepted: true,
      streamSession: { streamId: STREAM_ID, startedAt: WINDOW_START },
    } as unknown as ModuleExecutionContext;

    await processStatisticsEvent(offline, execution);

    expect(markWordStreamEnded).toHaveBeenCalledWith(STREAM_ID, WINDOW_END);
    expect(scheduleAlarm).toHaveBeenCalledWith("window", "window", Date.parse(WINDOW_END) + 300_000);
    execution.streamStateTransitionAccepted = false;
    await processStatisticsEvent(offline, execution);
    expect(markWordStreamEnded).toHaveBeenCalledTimes(1);
    expect(scheduleAlarm).toHaveBeenCalledTimes(1);
  });

  it("restores the shared alarm while offline stream words still need merge or pruning", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await writeStreamState(database, "offline", WINDOW_END);
    const chat = createStatisticsChat();
    chat.wordStreams.set(STREAM_ID, {
      words: [{ word: "pendingword", count: 1, lastSeenAt: WINDOW_END }],
      endedAt: WINDOW_END,
      expiresAt: Date.parse(WINDOW_END) + 24 * 60 * 60_000,
    });
    const { context, calls } = createContext(database, chat);

    await reconcileStatisticsSchedule(context, "stream_state");

    expect(calls.schedule).toHaveBeenCalledWith("window", Date.parse(WINDOW_END) + 300_000);
  });
});
