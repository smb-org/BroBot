import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { statisticsSettingsSchema, type StatisticsSettings } from "../../src/modules/statistics/contracts";
import { processStatisticsEvent } from "../../src/modules/statistics/service";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = Date.UTC(2026, 9, 25, 23, 59);
const STREAM_ID = "word-command-live-stream";
const databases: TestD1Database[] = [];

const setup = async (): Promise<{ channelId: string; database: TestD1Database }> => {
  const database = new TestD1Database();
  databases.push(database);
  const channelId = `statistics-word-command-${crypto.randomUUID()}`;
  await insertChannel(database, channelId);
  return { channelId, database };
};

const eventFor = (
  channelId: string,
  text: string,
  settings = statisticsSettingsSchema.parse({ wordCommand: { enabled: true } }),
  userId = "fictional-viewer-1",
  messageId = "fictional-word-command-1",
): ModuleEvent<StatisticsSettings> => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  receivedAt: new Date(NOW).toISOString(),
  actor: null,
  chatStatus: ["subscriber"],
  settings,
  payload: {
    message_id: messageId,
    chatter_user_id: userId,
    chatter_user_login: "frostfern",
    chatter_user_name: "Frost Fern",
    message: { text, fragments: [{ type: "text", text }] },
    badges: [{ set_id: "subscriber" }],
  },
});

const contextFor = (
  database: TestD1Database,
  options: {
    language?: "de" | "en";
    wordBatches?: readonly { batch: number; words: readonly { word: string; displayWord: string; count: number; lastSeenAt: string }[] }[];
    bufferedWord?: { word: string; displayWord: string; count: number; lastSeenAt: string } | null;
    claimCooldowns?: (claims: readonly { key: string; seconds: number }[]) => Promise<boolean>;
  } = {},
): ModuleExecutionContext => ({
  DB: database as unknown as D1Database,
  channelLanguage: () => Promise.resolve(options.language ?? "en"),
  points: {
    claimCooldown: () => Promise.resolve(true),
    claimCooldowns: options.claimCooldowns ?? (() => Promise.resolve(true)),
  },
  statisticsChat: {
    readWordCountForLookup: (streamId: string, word: string) => {
      const batches = streamId === STREAM_ID
        ? (options.wordBatches ?? []).map((batch) => ({
          ...batch,
          words: batch.words.filter((entry) => entry.word === word),
        })).filter((batch) => batch.words.length > 0)
        : [];
      const entries = streamId === STREAM_ID
        ? (options.wordBatches ?? []).flatMap((batch) => batch.words).filter((entry) => entry.word === word)
        : [];
      if (entries.length === 0) return Promise.resolve({ batches, streamWord: null, bufferedWord: options.bufferedWord ?? null });
      const first = entries[0];
      if (first === undefined) return Promise.resolve({ batches, streamWord: null, bufferedWord: options.bufferedWord ?? null });
      return Promise.resolve({
        batches,
        streamWord: {
          word,
          displayWord: first.displayWord,
          count: entries.reduce((sum, entry) => sum + entry.count, 0),
          lastSeenAt: entries.reduce((latest, entry) => latest < entry.lastSeenAt ? entry.lastSeenAt : latest, first.lastSeenAt),
        },
        bufferedWord: options.bufferedWord ?? null,
      });
    },
  },
} as unknown as ModuleExecutionContext);

const chatTexts = (actions: Awaited<ReturnType<typeof processStatisticsEvent>>["actions"]): string[] =>
  actions.flatMap((action) => action.kind === "chat" ? [action.text] : []);

const putBaselineWord = async (
  database: TestD1Database,
  channelId: string,
  word: string,
  count: number,
  displayWord: string,
  lastSeenAt = new Date(NOW).toISOString(),
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_word_frequency_baseline
       (channel_id, word, total_count, last_seen_at, display_word)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, word, count, lastSeenAt, displayWord).run();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("statistics word command", () => {
  it("replies with dashboard-matching live counts and an offline total", async () => {
    const { channelId, database } = await setup();
    await writeEventSubStreamState(
      database as unknown as D1Database,
      channelId,
      "online",
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW - 60_000).toISOString(),
      STREAM_ID,
    );
    await putBaselineWord(database, channelId, "fak", 3_765, "Faaak");
    const context = contextFor(database, {
      language: "de",
      wordBatches: [{ batch: 2, words: [{
        word: "fak", displayWord: "Fak", count: 47, lastSeenAt: new Date(NOW).toISOString(),
      }] }],
    });

    const live = await processStatisticsEvent(eventFor(channelId, "!wort faaak"), context);
    expect(chatTexts(live.actions)).toEqual(["Faaak: in diesem Stream 47×, insgesamt 3.812×"]);

    const offline = await setup();
    await putBaselineWord(offline.database, offline.channelId, "fak", 3_812, "Faaak");
    const total = await processStatisticsEvent(eventFor(offline.channelId, "!wort FAAAAK"), contextFor(offline.database, { language: "en" }));
    expect(chatTexts(total.actions)).toEqual(["Faaak: 3,812× in total"]);
  });

  it("includes the buffered word count in a live lookup", async () => {
    const { channelId, database } = await setup();
    await writeEventSubStreamState(
      database as unknown as D1Database,
      channelId,
      "online",
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW - 60_000).toISOString(),
      STREAM_ID,
    );
    await putBaselineWord(database, channelId, "fak", 3_765, "Faaak");
    const context = contextFor(database, {
      wordBatches: [{ batch: 2, words: [{
        word: "fak", displayWord: "Faaak", count: 47, lastSeenAt: new Date(NOW).toISOString(),
      }] }],
      bufferedWord: { word: "fak", displayWord: "FAAK", count: 2, lastSeenAt: new Date(NOW).toISOString() },
    });

    const result = await processStatisticsEvent(eventFor(channelId, "!wort faaak"), context);

    expect(chatTexts(result.actions)).toEqual(["Faaak: 49× this stream, 3,814× in total"]);
  });

  it("folds the argument and returns the stored display spelling", async () => {
    const { channelId, database } = await setup();
    await putBaselineWord(database, channelId, "fak", 8, "Faaak");

    const result = await processStatisticsEvent(eventFor(channelId, "!wort FAAAAK"), contextFor(database));

    expect(chatTexts(result.actions)).toEqual(["Faaak: 8× in total"]);
  });

  it("returns the unknown copy for ignored and hidden rare words", async () => {
    const ignored = await setup();
    await putBaselineWord(ignored.database, ignored.channelId, "fak", 8, "Faaak");
    const ignoredSettings = statisticsSettingsSchema.parse({
      ignoredWords: ["FAAAK"],
      wordCommand: { enabled: true },
    });
    const ignoredResult = await processStatisticsEvent(
      eventFor(ignored.channelId, "!wort faaak", ignoredSettings),
      contextFor(ignored.database),
    );
    expect(chatTexts(ignoredResult.actions)).toEqual(["Not counted yet: faaak"]);

    const unknownResult = await processStatisticsEvent(
      eventFor(ignored.channelId, "!wort NeverSeen"),
      contextFor(ignored.database),
    );
    expect(chatTexts(unknownResult.actions)).toEqual(["Not counted yet: NeverSeen"]);
    const germanUnknownResult = await processStatisticsEvent(
      eventFor(ignored.channelId, "!wort NeverSeen"),
      contextFor(ignored.database, { language: "de" }),
    );
    expect(chatTexts(germanUnknownResult.actions)).toEqual(["Noch nicht gezählt: NeverSeen"]);

    const rare = await setup();
    await putBaselineWord(rare.database, rare.channelId, "rareword", 2, "RareWord", "2026-10-17T23:58:00.000Z");
    const hiddenResult = await processStatisticsEvent(eventFor(rare.channelId, "!wort rareword"), contextFor(rare.database));
    expect(chatTexts(hiddenResult.actions)).toEqual(["Not counted yet: rareword"]);
  });

  it("claims global and per-user cooldowns together only when both are clear", async () => {
    const { channelId, database } = await setup();
    await putBaselineWord(database, channelId, "hello", 10, "hello");
    const active = new Map<string, number>();
    const claimCooldowns = vi.fn((claims: readonly { key: string; seconds: number }[]): Promise<boolean> => {
      if (claims.some(({ key }) => (active.get(key) ?? 0) > Date.now())) return Promise.resolve(false);
      for (const { key, seconds } of claims) active.set(key, Date.now() + seconds * 1_000);
      return Promise.resolve(true);
    });
    const context = contextFor(database, { claimCooldowns });

    const first = await processStatisticsEvent(eventFor(channelId, "!wort hello"), context);
    vi.advanceTimersByTime(11_000);
    const userLimited = await processStatisticsEvent(
      eventFor(channelId, "!wort hello", undefined, "fictional-viewer-1", "fictional-word-command-3"),
      context,
    );
    const secondUser = await processStatisticsEvent(
      eventFor(channelId, "!wort hello", undefined, "fictional-viewer-2", "fictional-word-command-2"),
      context,
    );

    expect(chatTexts(first.actions)).toEqual(["hello: 10× in total"]);
    expect(chatTexts(userLimited.actions)).toEqual([]);
    expect(chatTexts(secondUser.actions)).toEqual(["hello: 10× in total"]);
    expect(claimCooldowns.mock.calls).toEqual([
      [[{ key: "word-command:global", seconds: 10 }, { key: "word-command:user:fictional-viewer-1", seconds: 30 }]],
      [[{ key: "word-command:global", seconds: 10 }, { key: "word-command:user:fictional-viewer-1", seconds: 30 }]],
      [[{ key: "word-command:global", seconds: 10 }, { key: "word-command:user:fictional-viewer-2", seconds: 30 }]],
    ]);
  });

  it("does not reply to unsafe or non-word arguments", async () => {
    const { channelId, database } = await setup();
    await putBaselineWord(database, channelId, "fak", 10, "Faaak");
    const claimCooldowns = vi.fn(() => Promise.resolve(true));
    const context = contextFor(database, { claimCooldowns });

    for (const text of ["!wort !protected", "!wort /me x"]) {
      const result = await processStatisticsEvent(eventFor(channelId, text), context);
      expect(chatTexts(result.actions)).toEqual([]);
    }

    const result = await processStatisticsEvent(eventFor(channelId, "!wort faaak"), context);
    expect(chatTexts(result.actions)[0]).toMatch(/^Faaak/u);
    expect(claimCooldowns).toHaveBeenCalledTimes(1);
  });

  it("parses and excludes a command with leading whitespace", async () => {
    const { channelId, database } = await setup();
    const result = await processStatisticsEvent(eventFor(channelId, " !wort faaak"), contextFor(database));

    expect(chatTexts(result.actions)).toEqual(["Not counted yet: faaak"]);
  });

  it("does not reply or claim cooldowns while the command is disabled", async () => {
    const { channelId, database } = await setup();
    const claimCooldowns = vi.fn(() => Promise.resolve(true));
    const settings = statisticsSettingsSchema.parse({ wordCommand: { enabled: false } });

    const result = await processStatisticsEvent(
      eventFor(channelId, "!wort hello", settings),
      contextFor(database, { claimCooldowns }),
    );

    expect(chatTexts(result.actions)).toEqual([]);
    expect(claimCooldowns).not.toHaveBeenCalled();
  });
});
