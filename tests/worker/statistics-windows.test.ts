import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { statisticsTextFragments } from "../../src/modules/statistics/domain";
import { mergeStatisticsWordBatch } from "../../src/modules/statistics/service";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { notifyModuleScheduleInputsChanged } from "../../src/worker/module-schedules";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

// These tests run the real Durable Object SQLite statements and the real module alarm handler.
const worker = env as unknown as Env;
const WINDOW_MS = 300_000;
const TEST_NOW = Date.parse("2026-10-25T12:20:00.000Z");
const iso = (time: number): string => new Date(time).toISOString();
const stubs = new Set<DurableObjectStub>();

const statisticsObject = (channelId: string) => {
  const stub = worker.CHANNEL.get(worker.CHANNEL.idFromName(channelId));
  stubs.add(stub);
  return stub;
};

interface StatisticsWordObject {
  recordChatActivity(
    chatterUserId: string | null,
    needsActiveChatters: boolean,
    statistics: { windowStart: string; receivedAt: string; emotes: number; streamId: string; textFragments: readonly string[] },
  ): Promise<number>;
  readStatisticsWordCounts(streamId: string): Promise<Array<{ word: string; count: number; lastSeenAt: string }>>;
  markStatisticsWordStreamEnded(streamId: string, endedAt: string): Promise<void>;
  listMergeableStatisticsWordBuckets(
    streamState: "online" | "offline" | "unknown",
    streamId: string | null,
    idleBefore: number,
  ): Promise<Array<{ streamId: string; batch: number }>>;
  prepareStatisticsWordBucketForMerge(
    bucket: { streamId: string; batch: number },
    streamState: "online" | "offline" | "unknown",
    streamId: string | null,
    idleBefore: number,
  ): Promise<Array<{ word: string; count: number; lastSeenAt: string; firstInStream: boolean }>>;
  deleteStatisticsWordBucket(bucket: { streamId: string; batch: number }): Promise<void>;
  pruneExpiredStatisticsWordStreams(now: number): Promise<void>;
  hasStatisticsWordStreams(): Promise<boolean>;
}

// The RPC type of an `unknown` result is not thenable for the linter, but the call is a promise.
const runWindowAlarm = async (object: ReturnType<typeof statisticsObject>): Promise<void> => {
  await (object.runModuleAlarm("statistics", "window", "window") as unknown as Promise<unknown>);
};

const pastWindowStart = (): number => Math.floor((Date.now() - 20 * 60_000) / WINDOW_MS) * WINDOW_MS;

const statisticsRows = async (channelId: string) => (await worker.DB.prepare(
  `SELECT stream_id, window_start, messages, emotes, viewer_count, chatters, active_chatters
     FROM channel_statistics WHERE channel_id = ? ORDER BY window_start`,
).bind(channelId).all()).results;

describe("statistics windows in the channel object", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
  });

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    // A scheduled platform alarm must not fire after the test body.
    await Promise.all([...stubs].map((stub) => runInDurableObject(stub, async (_object, state) => {
      await state.storage.deleteAlarm();
    })));
    stubs.clear();
    vi.useRealTimers();
  });

  it("writes an offline window with absolute totals and raises it for a late message", async () => {
    const channelId = "statistics-window-offline";
    await insertPointChannel(channelId);
    const windowStart = pastWindowStart();
    const endedAt = windowStart + 200_000;
    await writeEventSubStreamState(worker.DB, channelId, "offline", iso(endedAt), null);
    const object = statisticsObject(channelId);
    const message = (offset: number, emotes: number) => ({
      windowStart: iso(windowStart),
      receivedAt: iso(windowStart + offset),
      emotes,
      streamId: "stream-1",
    });

    await object.recordChatActivity("viewer-1", true, message(90_000, 2));
    await object.recordChatActivity("viewer-2", true, message(120_000, 2));
    await runWindowAlarm(object);

    const first = await statisticsRows(channelId);
    expect(first).toEqual([{
      stream_id: "stream-1",
      window_start: iso(windowStart),
      messages: 2,
      emotes: 4,
      viewer_count: null,
      chatters: null,
      active_chatters: null,
    }]);

    // A repeated alarm run writes the same absolute totals, never a doubled or lowered row.
    await runWindowAlarm(object);
    expect(await statisticsRows(channelId)).toEqual(first);

    await object.recordChatActivity("viewer-3", true, message(150_000, 1));
    await runWindowAlarm(object);
    const [late] = await statisticsRows(channelId);
    expect(late).toMatchObject({ messages: 3, emotes: 5 });
  });

  it("keeps one window per epoch slot across an offline/online flap", async () => {
    const channelId = "statistics-window-flap";
    await insertPointChannel(channelId);
    const windowStart = pastWindowStart();
    await writeEventSubStreamState(worker.DB, channelId, "offline", iso(windowStart + 250_000), null);
    const object = statisticsObject(channelId);
    const message = (offset: number) => ({
      windowStart: iso(windowStart),
      receivedAt: iso(windowStart + offset),
      emotes: 0,
      streamId: "stream-2",
    });

    await object.recordChatActivity(null, false, message(20_000));
    await object.recordChatActivity(null, false, message(160_000));
    await runWindowAlarm(object);

    expect(await statisticsRows(channelId)).toMatchObject([{
      window_start: iso(windowStart),
      messages: 2,
    }]);
  });

  it("buffers counts until the alarm and enforces the persisted 20,000-word stream cap", async () => {
    const channelId = "statistics-word-cap";
    await insertPointChannel(channelId);
    const stub = statisticsObject(channelId);
    const object = statisticsObject(channelId) as unknown as StatisticsWordObject;
    const streamId = "word-stream-cap";
    const timestamp = iso(Date.now());
    await object.recordChatActivity(null, false, {
      windowStart: iso(pastWindowStart()), receivedAt: timestamp, emotes: 0, streamId, textFragments: [],
    });
    await runInDurableObject(stub, (_object, state) => {
      state.storage.sql.exec(
        `INSERT INTO statistics_word_streams (stream_id, distinct_words, ended_at, expires_at, current_batch)
         VALUES (?, 20000, NULL, ?, 1)`,
        streamId,
        Date.now() + 24 * 60 * 60_000,
      );
      state.storage.sql.exec(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (0) UNION ALL SELECT value + 1 FROM sequence WHERE value < 19999
         )
         INSERT INTO statistics_word_seen (stream_id, word, first_batch)
         SELECT ?, 'term' || printf('%05d', value), 1 FROM sequence`,
        streamId,
      );
      state.storage.sql.exec(
        `INSERT INTO statistics_word_counts
           (stream_id, batch, word, count, last_seen_at, last_increment_at)
         VALUES (?, 1, 'term00000', 1, ?, ?)`,
        streamId,
        timestamp,
        Date.now() - 1,
      );
    });
    await object.recordChatActivity(null, false, {
      windowStart: iso(pastWindowStart()),
      receivedAt: timestamp,
      emotes: 0,
      streamId,
      textFragments: ["term00000 overflowword"],
    });

    // Only the seeded row is persisted; the new increment waits in memory for the alarm.
    await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([
      { word: "term00000", count: 1, lastSeenAt: timestamp },
    ]);
    await runWindowAlarm(stub);

    await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([
      { word: "term00000", count: 2, lastSeenAt: timestamp },
    ]);
    await expect(runInDurableObject(stub, (_object, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM statistics_word_seen WHERE stream_id = ?", streamId,
      ).one().count)).resolves.toBe(20_000);
  });

  it("flushes more than 100 buffered words through bounded multi-row upserts", async () => {
    const channelId = "statistics-word-flush-batches";
    await insertPointChannel(channelId);
    const stub = statisticsObject(channelId);
    const object = stub as unknown as StatisticsWordObject;
    const streamId = "word-stream-flush-batches";
    const words = Array.from({ length: 120 }, (_unused, index) => `chunkword${String(index).padStart(3, "0")}`);

    for (let offset = 0; offset < words.length; offset += 20) {
      await object.recordChatActivity(null, false, {
        windowStart: iso(pastWindowStart()),
        receivedAt: iso(Date.now()),
        emotes: 0,
        streamId,
        textFragments: [words.slice(offset, offset + 20).join(" ")],
      });
    }
    await runWindowAlarm(stub);

    await expect(runInDurableObject(stub, (_object, state) =>
      state.storage.sql.exec<{ count: number; max_batch: number }>(
        "SELECT COUNT(*) AS count, MAX(batch) AS max_batch FROM statistics_word_counts WHERE stream_id = ?",
        streamId,
      ).one())).resolves.toEqual({ count: 120, max_batch: 1 });
  });

  it("persists Unicode words once per message at the alarm and loses only unflushed counts on eviction", async () => {
    const channelId = "statistics-word-eviction";
    await insertPointChannel(channelId);
    const stub = statisticsObject(channelId);
    const object = stub as unknown as StatisticsWordObject;
    const streamId = "word-stream-eviction";
    const receivedAt = iso(Date.now());
    const record = (text: string) => object.recordChatActivity(null, false, {
      windowStart: iso(pastWindowStart()), receivedAt, emotes: 0, streamId, textFragments: [text],
    });

    await record("İstanbul नमस्ते हिन्दी groß Straße 😊 😊 heute heute");
    await record("heute");
    await runWindowAlarm(stub);
    await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([
      { word: "heute", count: 2, lastSeenAt: receivedAt },
      { word: "groß", count: 1, lastSeenAt: receivedAt },
      { word: "straße", count: 1, lastSeenAt: receivedAt },
      { word: "i̇stanbul", count: 1, lastSeenAt: receivedAt },
      { word: "नमस्ते", count: 1, lastSeenAt: receivedAt },
      { word: "हिन्दी", count: 1, lastSeenAt: receivedAt },
    ].sort((left, right) => right.count - left.count || (left.word < right.word ? -1 : 1)));

    await record("lostword lostword");
    // Eviction drops every in-memory field and keeps the SQLite rows; emulate exactly that.
    await runInDurableObject(stub, (instance) => {
      const buffers = instance as unknown as Record<string, Map<string, unknown>>;
      for (const name of ["statisticsWordCounts", "statisticsWordWordsByStream", "statisticsWordNewDistinctByStream",
        "statisticsWordStreamEndedAt"]) buffers[name]?.clear();
    });
    await runWindowAlarm(stub);
    const words = await object.readStatisticsWordCounts(streamId);
    expect(words.map(({ word }) => word)).not.toContain("lostword");
    expect(words).toHaveLength(6);
  });

  it("never merges a different stream while its word bucket keeps receiving increments", async () => {
    const channelId = "statistics-word-stale-stream-read";
    await insertPointChannel(channelId);
    const staleStreamId = "stream-a";
    const activeStreamId = "stream-b";
    await writeEventSubStreamState(worker.DB, channelId, "online", iso(Date.now()), iso(Date.now()), staleStreamId);
    const object = statisticsObject(channelId);
    const windowStart = pastWindowStart();

    for (let interval = 0; interval < 4; interval += 1) {
      if (interval > 0) vi.advanceTimersByTime(5 * 60_000);
      await object.recordChatActivity(null, false, {
        windowStart: iso(windowStart),
        receivedAt: iso(Date.now()),
        emotes: 0,
        streamId: activeStreamId,
        textFragments: ["activeword"],
      });
      await runWindowAlarm(object);
    }

    await expect(worker.DB.prepare(
      "SELECT total_count FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = ?",
    ).bind(channelId, "activeword").first()).resolves.toBeNull();
    await expect((object as unknown as StatisticsWordObject).readStatisticsWordCounts(activeStreamId))
      .resolves.toEqual([{ word: "activeword", count: 4, lastSeenAt: iso(Date.now()) }]);
  });

  it("merges an idle ended bucket and keeps later counts for the next batch", async () => {
    const channelId = "statistics-word-merge-success";
    await insertPointChannel(channelId);
    const object = statisticsObject(channelId) as unknown as StatisticsWordObject;
    const windowStart = Math.floor((Date.now() - 2 * 60 * 60_000) / WINDOW_MS) * WINDOW_MS;
    const receivedAt = iso(windowStart + 90_000);
    const streamId = "word-stream-success";
    await object.recordChatActivity(null, false, {
      windowStart: iso(windowStart), receivedAt, emotes: 0, streamId, textFragments: ["bonjour bonjour monde"],
    });
    await object.markStatisticsWordStreamEnded(streamId, iso(windowStart + 240_000));
    await writeEventSubStreamState(worker.DB, channelId, "offline", iso(windowStart + 240_000), null);
    vi.advanceTimersByTime(15 * 60_000);
    await runWindowAlarm(statisticsObject(channelId));

    await expect(worker.DB.prepare(
      `SELECT total_count, streams_seen FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word = ?`,
    ).bind(channelId, "bonjour").first()).resolves.toEqual({ total_count: 1, streams_seen: 1 });
    await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([]);
    await expect(object.hasStatisticsWordStreams()).resolves.toBe(true);

    const lateAt = Date.now();
    await object.recordChatActivity(null, false, {
      windowStart: iso(pastWindowStart()),
      receivedAt: iso(lateAt),
      emotes: 0,
      streamId,
      textFragments: ["bonjour"],
    });
    await runWindowAlarm(statisticsObject(channelId));
    await expect(runInDurableObject(statisticsObject(channelId), (_object, state) =>
      state.storage.sql.exec<{ batch: number; count: number }>(
        "SELECT batch, count FROM statistics_word_counts WHERE stream_id = ?", streamId,
      ).toArray())).resolves.toEqual([{ batch: 2, count: 1 }]);

    vi.advanceTimersByTime(15 * 60_000);
    await runWindowAlarm(statisticsObject(channelId));
    await runWindowAlarm(statisticsObject(channelId));
    await expect(worker.DB.prepare(
      `SELECT total_count, streams_seen FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word = ?`,
    ).bind(channelId, "bonjour").first()).resolves.toEqual({ total_count: 2, streams_seen: 1 });
    await expect(worker.DB.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(channelId, streamId).first()).resolves.toEqual({ count: 2 });
  });

  it("deletes ended per-stream words when their 24-hour age limit expires", async () => {
    const channelId = "statistics-word-age-prune";
    await insertPointChannel(channelId);
    const object = statisticsObject(channelId) as unknown as StatisticsWordObject;
    const windowStart = pastWindowStart();
    const streamId = "word-stream-age";
    await object.recordChatActivity(null, false, {
      windowStart: iso(windowStart),
      receivedAt: iso(windowStart + 90_000),
      emotes: 0,
      streamId,
      textFragments: ["ageword"],
    });
    const endedAt = Date.now();
    await object.markStatisticsWordStreamEnded(streamId, iso(endedAt));

    await object.pruneExpiredStatisticsWordStreams(endedAt + 24 * 60 * 60_000 + 1);

    await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([]);
    await expect(object.hasStatisticsWordStreams()).resolves.toBe(false);
  });

  it("counts words from text fragments only and persists nothing but anonymous word counts", async () => {
    const channelId = "statistics-word-privacy";
    await insertPointChannel(channelId);
    const stub = statisticsObject(channelId);
    const object = stub as unknown as StatisticsWordObject;
    const windowStart = pastWindowStart();
    const textFragments = statisticsTextFragments({
      message: {
        fragments: [
          { type: "text", text: "Hello world, hello!! https://example.com/secretlink ich 42 ab " },
          { type: "emote", text: "KappaEmote" },
          { type: "mention", text: "mentioneduser" },
          { type: "cheermote", text: "Cheer100" },
          { type: "text", text: " @typedmention :colonemote: again" },
        ],
      },
    });
    await object.recordChatActivity("user-id-4711", false, {
      windowStart: iso(windowStart),
      receivedAt: iso(windowStart + 30_000),
      emotes: 1,
      streamId: "word-stream-privacy",
      textFragments,
    });

    await expect(object.readStatisticsWordCounts("word-stream-privacy")).resolves.toEqual([]);
    await expect(runInDurableObject(stub, (_object, state) =>
      state.storage.sql.exec("SELECT * FROM statistics_word_counts").toArray())).resolves.toEqual([]);
    await runWindowAlarm(stub);

    await expect(object.readStatisticsWordCounts("word-stream-privacy")).resolves.toEqual([
      { word: "again", count: 1, lastSeenAt: iso(windowStart + 30_000) },
      { word: "hello", count: 1, lastSeenAt: iso(windowStart + 30_000) },
      { word: "world", count: 1, lastSeenAt: iso(windowStart + 30_000) },
    ]);
    const stored = await runInDurableObject(stub, (_object, state) => JSON.stringify([
      ...state.storage.sql.exec("SELECT * FROM statistics_word_streams").toArray(),
      ...state.storage.sql.exec("SELECT * FROM statistics_word_counts").toArray(),
      ...state.storage.sql.exec("SELECT * FROM statistics_word_seen").toArray(),
    ]));
    for (const forbidden of ["KappaEmote", "mentioneduser", "Cheer100", "typedmention", "colonemote", "secretlink", "user-id-4711", "Hello world"]) {
      expect(stored.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("merges a stream into the real D1 baseline once and trims it to 5,000 words", async () => {
    const channelId = "statistics-word-d1-merge";
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (0) UNION ALL SELECT value + 1 FROM sequence WHERE value < 4999
       )
       INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, streams_seen, last_seen_at)
       SELECT ?, 'seed' || printf('%05d', value), value + 2, 1, '2026-10-25T12:00:00.000Z' FROM sequence`,
    ).bind(channelId).run();
    const words = [{ word: "freshword", count: 3, lastSeenAt: "2026-10-25T12:05:00.000Z", firstInStream: true }];

    await mergeStatisticsWordBatch(worker.DB, channelId, "d1-stream", 1, words, "2026-10-25T12:06:00.000Z");
    await mergeStatisticsWordBatch(worker.DB, channelId, "d1-stream", 1, words, "2026-10-25T12:07:00.000Z");

    const total = await worker.DB.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
    ).bind(channelId).first<{ count: number }>();
    expect(total?.count).toBe(5_000);
    await expect(worker.DB.prepare(
      "SELECT word FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = 'seed00000'",
    ).bind(channelId).first()).resolves.toBeNull();
    await expect(worker.DB.prepare(
      "SELECT total_count, streams_seen FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = 'freshword'",
    ).bind(channelId).first()).resolves.toEqual({ total_count: 3, streams_seen: 1 });
  });

  it("reaches a failed word merge and lets the alarm prune the bucket at 24 hours", async () => {
    const channelId = "statistics-word-d1-failure";
    await insertPointChannel(channelId);
    const stub = statisticsObject(channelId);
    const object = stub as unknown as StatisticsWordObject;
    const windowStart = pastWindowStart();
    const streamId = "word-stream-d1-failure";
    const trigger = "fail_statistics_word_baseline";
    await worker.DB.prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON channel_word_frequency_baseline
       BEGIN SELECT RAISE(ABORT, 'Injected word baseline merge failure.'); END`,
    ).run();
    try {
      await object.recordChatActivity(null, false, {
        windowStart: iso(windowStart),
        receivedAt: iso(windowStart + 30_000),
        emotes: 0,
        streamId,
        textFragments: ["retryword retryword"],
      });
      const endedAt = Date.now();
      await object.markStatisticsWordStreamEnded(streamId, iso(endedAt));
      await writeEventSubStreamState(worker.DB, channelId, "offline", iso(endedAt), null);
      vi.advanceTimersByTime(15 * 60_000);

      await expect(runWindowAlarm(stub)).rejects.toThrow("Injected word baseline merge failure.");
      await expect(worker.DB.prepare(
        "SELECT COUNT(*) AS count FROM channel_statistics WHERE channel_id = ?",
      ).bind(channelId).first()).resolves.toEqual({ count: 1 });
      await expect(object.listMergeableStatisticsWordBuckets("offline", null, Date.now()))
        .resolves.toEqual([{ streamId, batch: 1 }]);
      await expect(object.readStatisticsWordCounts(streamId)).resolves.toHaveLength(1);
      await expect(worker.DB.prepare(
        "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
      ).bind(channelId).first()).resolves.toEqual({ count: 0 });

      vi.setSystemTime(endedAt + 24 * 60 * 60_000 + 1);
      await runWindowAlarm(stub);
      await expect(object.readStatisticsWordCounts(streamId)).resolves.toEqual([]);
      await expect(object.hasStatisticsWordStreams()).resolves.toBe(false);
    } finally {
      await worker.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
    }
  });

  it("arms exactly one window alarm for an already-live channel from the stream-state refresh", async () => {
    const channelId = "statistics-window-refresh";
    await insertPointChannel(channelId);
    const startedAt = Date.now() - 20 * 60_000;
    await writeEventSubStreamState(worker.DB, channelId, "online", iso(startedAt), iso(startedAt), "stream-1");
    const object = statisticsObject(channelId);

    await expect(object.getModuleAlarmDeadline("statistics", "window")).resolves.toBeNull();
    await notifyModuleScheduleInputsChanged(worker.CHANNEL, channelId, "stream_state");
    await runDurableObjectAlarm(object);
    const deadline = await object.getModuleAlarmDeadline("statistics", "window");
    expect(deadline).not.toBeNull();
    expect((deadline ?? 1) % WINDOW_MS).toBe(0);

    // A second refresh with the alarm already armed leaves the deadline untouched.
    await notifyModuleScheduleInputsChanged(worker.CHANNEL, channelId, "stream_state");
    await runDurableObjectAlarm(object);
    await expect(object.getModuleAlarmDeadline("statistics", "window")).resolves.toBe(deadline);
  });
});
