import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  admitStatisticsWordCounts,
  statisticsTextFragments,
  tokenizeStatisticsWords,
} from "../../src/modules/statistics/domain";
import { mergeStatisticsWordBatch } from "../../src/modules/statistics/service";
import { insertChannel } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

describe("statistics word baseline tokeniser", () => {
  it("counts text and emote fragments while ignoring stop words, links, mentions, short tokens and numbers", () => {
    const fragments = statisticsTextFragments({
      message: {
        fragments: [
          { type: "text", text: "DAS ＨＡＬＬＯ, café café! ich an the with 42 123" },
          { type: "emote", text: "Kappa" },
          { type: "mention", text: "someone" },
          { type: "cheermote", text: "Cheer100" },
          { type: "text", text: "@viewer https://example.com/a :Kappa: twitch.tv/foo bleibt" },
        ],
      },
    });

    expect(fragments).toEqual(["DAS ＨＡＬＬＯ, café café! ich an the with 42 123", "Kappa", "@viewer https://example.com/a :Kappa: twitch.tv/foo bleibt"]);
    expect(tokenizeStatisticsWords(fragments)).toEqual(new Map([
      ["halo", 1],
      ["café", 1],
      ["kapa", 1],
      ["bleibt", 1],
    ]));
  });

  it("ignores words containing dots or slashes and words made only of numbers", () => {
    expect(tokenizeStatisticsWords(["to words example.com chat/path 12345 words"])).toEqual(new Map([
      ["words", 1],
    ]));
  });

  it("keeps combining marks and Unicode letters while ignoring emoji and oversized tokens", () => {
    expect(tokenizeStatisticsWords([
      "İstanbul नमस्ते हिन्दी ÄÖÜ äöü groß Straße @İstanbul :Märk: 😊",
      "x".repeat(41),
    ])).toEqual(new Map([
      ["i\u0307stanbul", 1],
      ["नमस्ते", 1],
      ["हिन्दी", 1],
      ["äöü", 1],
      ["groß", 1],
      ["straße", 1],
    ]));
  });

  it("counts each normalized word once across fragments and caps a message at 20 distinct words", () => {
    expect(tokenizeStatisticsWords([
      "term00 term01 term02 term03 term04 term05 term06 term07 term08 term09 term10 term11",
      "term00 term01 term02 term03 term04 term05 term06 term07 term08 term09 term10 term11 term12 term13 term14 term15 term16 term17 term18 term19 term20 term21",
    ])).toEqual(new Map([
      ["term00", 1], ["term01", 1], ["term02", 1], ["term03", 1], ["term04", 1],
      ["term05", 1], ["term06", 1], ["term07", 1], ["term08", 1], ["term09", 1],
      ["term10", 1], ["term11", 1], ["term12", 1], ["term13", 1], ["term14", 1],
      ["term15", 1], ["term16", 1], ["term17", 1], ["term18", 1], ["term19", 1],
    ]));
  });

  it("keeps incrementing existing words at the distinct-word cap and admits no new words", () => {
    const candidates = new Map([["knownword", 2], ["firstnew", 1], ["secondnew", 1]]);
    const existing = new Set(["knownword"]);

    expect(admitStatisticsWordCounts(candidates, existing, 20_000)).toEqual({
      accepted: new Map([["knownword", 2]]),
      addedDistinctWords: 0,
    });
    expect(admitStatisticsWordCounts(candidates, existing, 19_999)).toEqual({
      accepted: new Map([["knownword", 2], ["firstnew", 1]]),
      addedDistinctWords: 1,
    });
  });
});

describe("statistics word baseline merge", () => {
  it("folds legacy baseline variants once and keeps the highest-count original spelling", async () => {
    const database = new TestD1Database();
    const channelId = "word-baseline-fold-legacy";
    await insertChannel(database, channelId);
    database.sqlite.exec("DROP TABLE channel_word_frequency_baseline_folded; DROP TABLE channel_word_frequency_baseline");
    database.sqlite.exec(`
      CREATE TABLE channel_word_frequency_baseline (
        channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
        word TEXT NOT NULL,
        total_count INTEGER NOT NULL CHECK (total_count > 0),
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, word)
      ) WITHOUT ROWID;
      CREATE INDEX channel_word_frequency_baseline_top_idx
        ON channel_word_frequency_baseline (channel_id, total_count DESC, word ASC);
    `);
    await database.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).bind(
      channelId, "faaak", 5, "2026-10-25T12:00:00.000Z",
      channelId, "fak", 2, "2026-10-25T12:01:00.000Z",
      channelId, "baaaak", 4, "2026-10-25T12:00:00.000Z",
      channelId, "bak", 4, "2026-10-25T12:01:00.000Z",
    ).run();
    database.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0091_statistics_word_display.sql"), "utf8"));

    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "fold-stream", 1, [
      { word: "fak", displayWord: "FAAAK", count: 3, lastSeenAt: "2026-10-25T12:05:00.000Z" },
      { word: "freshword", displayWord: "FreshWord", count: 1, lastSeenAt: "2026-10-25T12:05:00.000Z" },
    ], "2026-10-25T12:06:00.000Z");
    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "fold-stream", 1, [
      { word: "fak", displayWord: "FAAAK", count: 3, lastSeenAt: "2026-10-25T12:05:00.000Z" },
    ], "2026-10-25T12:07:00.000Z");

    await expect(database.prepare(
      `SELECT word, total_count, display_word FROM channel_word_frequency_baseline
        WHERE channel_id = ? ORDER BY word`,
    ).bind(channelId).all()).resolves.toMatchObject({ results: [
      { word: "bak", total_count: 8, display_word: "baaaak" },
      { word: "fak", total_count: 10, display_word: "faaak" },
      { word: "freshword", total_count: 1, display_word: "FreshWord" },
    ] });
  });

  it("keeps the first display spelling across later batches", async () => {
    const database = new TestD1Database();
    const channelId = "word-baseline-first-display";
    await insertChannel(database, channelId);
    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "prune-stream", 1, [
      { word: "bonjour", displayWord: "Bonjour", count: 2, lastSeenAt: "2026-10-25T12:05:00.000Z" },
    ], "2026-10-25T12:06:00.000Z");
    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "prune-stream", 2, [
      { word: "bonjour", displayWord: "BONJOUR", count: 4, lastSeenAt: "2026-10-25T12:10:00.000Z" },
    ], "2026-10-25T12:11:00.000Z");

    await expect(database.prepare(
      "SELECT total_count, display_word FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = 'bonjour'",
    ).bind(channelId).first()).resolves.toEqual({ total_count: 6, display_word: "Bonjour" });
  });

  it("adds counts across two batches of the same stream even when each batch is rare", async () => {
    const database = new TestD1Database();
    const channelId = "word-baseline-same-stream-batches";
    await insertChannel(database, channelId);

    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "same-stream", 1, [
      { word: "bonjour", displayWord: "bonjour", count: 2, lastSeenAt: "2026-10-25T12:00:00.000Z" },
    ], "2026-10-25T12:05:00.000Z");
    await mergeStatisticsWordBatch(database as unknown as D1Database, channelId, "same-stream", 2, [
      { word: "bonjour", displayWord: "bonjour", count: 2, lastSeenAt: "2026-10-25T12:10:00.000Z" },
    ], "2026-10-25T12:15:00.000Z");

    await expect(database.prepare(
      "SELECT total_count FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = 'bonjour'",
    ).bind(channelId).first()).resolves.toEqual({ total_count: 4 });
  });

  it("does not double-count a batch when D1 committed but the response was lost", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "word-baseline-retry");
    let responseLost = false;
    const ambiguousDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: TestPreparedStatement[]) => {
        const result = await database.batch(statements);
        if (!responseLost) {
          responseLost = true;
          throw new Error("Simulated lost D1 response.");
        }
        return result;
      },
    } as unknown as D1Database;
    const wordCounts = [{ word: "bonjour", displayWord: "Bonjour", count: 3, lastSeenAt: "2026-10-25T12:00:00.000Z" }];

    await expect(mergeStatisticsWordBatch(
      ambiguousDatabase,
      "word-baseline-retry",
      "stream-retry",
      1,
      wordCounts,
      "2026-10-25T12:05:00.000Z",
    )).rejects.toThrow("Simulated lost D1 response.");
    await mergeStatisticsWordBatch(
      database as unknown as D1Database,
      "word-baseline-retry",
      "stream-retry",
      1,
      wordCounts,
      "2026-10-25T12:06:00.000Z",
    );

    await expect(database.prepare(
      `SELECT total_count, last_seen_at
         FROM channel_word_frequency_baseline
        WHERE channel_id = ? AND word = ?`,
    ).bind("word-baseline-retry", "bonjour").first()).resolves.toEqual({
      total_count: 3,
      last_seen_at: "2026-10-25T12:00:00.000Z",
    });
  });

  it("merges only the top 1,000 words from a stream", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "word-baseline-stream-cap");
    const words = Array.from({ length: 1_005 }, (_unused, index) => ({
      word: `word${String(index).padStart(4, "0")}`,
      displayWord: `Word${String(index).padStart(4, "0")}`,
      count: index + 1,
      lastSeenAt: "2026-10-25T12:00:00.000Z",
    }));

    await mergeStatisticsWordBatch(
      database as unknown as D1Database,
      "word-baseline-stream-cap",
      "stream-top-k",
      1,
      words,
      "2026-10-25T12:05:00.000Z",
    );

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
    ).bind("word-baseline-stream-cap").first()).resolves.toEqual({ count: 1_000 });
    await expect(database.prepare(
      "SELECT total_count FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = ?",
    ).bind("word-baseline-stream-cap", "word1004").first()).resolves.toEqual({ total_count: 1_005 });
    await expect(database.prepare(
      "SELECT word FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = ?",
    ).bind("word-baseline-stream-cap", "word0000").first()).resolves.toBeNull();
  });

  it("trims the channel baseline to its 5,000 most frequent words", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "word-baseline-channel-cap");
    await database.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (0) UNION ALL SELECT value + 1 FROM sequence WHERE value < 5_000
       )
       INSERT INTO channel_word_frequency_baseline
         (channel_id, word, total_count, last_seen_at)
       SELECT ?, 'word' || printf('%05d', value), value + 1, '2026-10-25T12:00:00.000Z' FROM sequence`,
    ).bind("word-baseline-channel-cap").run();
    await mergeStatisticsWordBatch(
      database as unknown as D1Database,
      "word-baseline-channel-cap",
      "stream-channel-top-n",
      1,
      [{ word: "freshword", displayWord: "FreshWord", count: 10, lastSeenAt: "2026-10-25T12:05:00.000Z" }],
      "2026-10-25T12:06:00.000Z",
    );

    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_baseline WHERE channel_id = ?",
    ).bind("word-baseline-channel-cap").first()).resolves.toEqual({ count: 5_000 });
    await expect(database.prepare(
      "SELECT word FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = ?",
    ).bind("word-baseline-channel-cap", "word00000").first()).resolves.toBeNull();
    await expect(database.prepare(
      "SELECT total_count FROM channel_word_frequency_baseline WHERE channel_id = ? AND word = ?",
    ).bind("word-baseline-channel-cap", "freshword").first()).resolves.toEqual({ total_count: 10 });
  });

  it("merges later batches once each and ignores a repeated batch", async () => {
    const database = new TestD1Database();
    await insertChannel(database, "word-baseline-late-batch");
    await mergeStatisticsWordBatch(database as unknown as D1Database, "word-baseline-late-batch", "stream-late", 1, [
      { word: "bonjour", displayWord: "bonjour", count: 3, lastSeenAt: "2026-10-25T12:00:00.000Z" },
    ], "2026-10-25T12:05:00.000Z");
    await mergeStatisticsWordBatch(database as unknown as D1Database, "word-baseline-late-batch", "stream-late", 2, [
      { word: "bonjour", displayWord: "bonjour", count: 3, lastSeenAt: "2026-10-25T12:10:00.000Z" },
      { word: "lateword", displayWord: "LateWord", count: 1, lastSeenAt: "2026-10-25T12:10:00.000Z" },
    ], "2026-10-25T12:15:00.000Z");
    await mergeStatisticsWordBatch(database as unknown as D1Database, "word-baseline-late-batch", "stream-late", 2, [
      { word: "bonjour", displayWord: "bonjour", count: 3, lastSeenAt: "2026-10-25T12:10:00.000Z" },
      { word: "lateword", displayWord: "LateWord", count: 1, lastSeenAt: "2026-10-25T12:10:00.000Z" },
    ], "2026-10-25T12:16:00.000Z");

    await expect(database.prepare(
      "SELECT word, total_count FROM channel_word_frequency_baseline WHERE channel_id = ? ORDER BY word",
    ).bind("word-baseline-late-batch").all()).resolves.toMatchObject({ results: [
      { word: "bonjour", total_count: 6 },
      { word: "lateword", total_count: 1 },
    ] });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_word_frequency_streams WHERE channel_id = ?",
    ).bind("word-baseline-late-batch").first()).resolves.toEqual({ count: 2 });
  });
});
