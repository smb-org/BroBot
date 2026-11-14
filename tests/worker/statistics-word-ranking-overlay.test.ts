import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import type { ModuleOverlayElementContext } from "../../src/modules/contract";
import { statisticsWordRankingOverlayElement } from "../../src/modules/statistics/overlay/ranking-element";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

const worker = env as unknown as Env;
const stubs = new Set<DurableObjectStub>();
const TEST_NOW = (Math.floor(Date.now() / 300_000) + 1) * 300_000;

const channelObject = (channelId: string): DurableObjectStub => {
  const stub = worker.CHANNEL.get(worker.CHANNEL.idFromName(channelId));
  stubs.add(stub);
  return stub;
};

/** Runs the alarm inside the object; a failing handler rejection crossing the stub would be an unhandled rejection. */
const runFailingAlarm = (stub: DurableObjectStub): Promise<void> =>
  runInDurableObject(stub, async (durableObject) => {
    try {
      await (durableObject as unknown as { alarm(): Promise<void> }).alarm();
    } catch {
      // The handler rethrows after rescheduling; the test reads the schedule instead.
    }
  });

const seedWordRanking = async (
  channelId: string,
  scope: "stream" | "total",
  config: Record<string, unknown> = {},
  inComposition = true,
): Promise<void> => {
  const now = new Date(TEST_NOW).toISOString();
  const overlayId = `overlay-${channelId}`;
  await worker.DB.batch([
    worker.DB.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
       VALUES (?, ?, 'Word ranking test', 800, 450, '', 1, ?, ?)`,
    ).bind(overlayId, channelId, now, now),
    worker.DB.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision)
       VALUES (?, 'statistics', 1, '{}', 1)
       ON CONFLICT(channel_id, module_id) DO UPDATE SET enabled = 1, settings = excluded.settings`,
    ).bind(channelId),
    worker.DB.prepare(
      `INSERT INTO overlay_elements
         (element_id, channel_id, overlay_id, kind, label, config_json, x, y, scale_percent, z, in_composition)
       VALUES (?, ?, ?, 'statistics.word_ranking', 'Ranking', ?, 0, 0, 100, 0, ?)`,
    ).bind(`element-${channelId}`, channelId, overlayId, JSON.stringify({ scope, count: 5, bars: true, ...config }), inComposition ? 1 : 0),
  ]);
};

const chatActivity = (
  object: { recordChatActivity: (userId: null, active: false, value: {
    windowStart: string; receivedAt: string; emotes: number; streamId: string; textFragments: readonly string[];
  }) => Promise<number> },
  streamId: string,
  text: string,
  receivedAt = new Date(Date.now()).toISOString(),
): Promise<number> => object.recordChatActivity(null, false, {
  windowStart: new Date(Math.floor(Date.parse(receivedAt) / 300_000) * 300_000).toISOString(),
  receivedAt,
  emotes: 0,
  streamId,
  textFragments: [text],
});

const maximumUnicodeWord = (variant: number, uppercase = false): string =>
  Array.from({ length: 40 }, (_, index) => String.fromCodePoint((uppercase ? 0x10400 : 0x10428) + ((index + variant) % 40)))
    .join("");

beforeAll(runMigrations);

afterEach(async () => {
  await Promise.all([...stubs].map((stub) => runInDurableObject(stub, async (_object, state) => {
    await state.storage.deleteAlarm();
  })));
  stubs.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("statistics word ranking worker state", () => {
  it("filters ignored, filler, and hidden rare words while preserving display spelling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-filters-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    await worker.DB.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'statistics'")
      .bind(JSON.stringify({ wordCommand: {}, ignoredWords: ["ignored"] }), channelId).run();
    const recent = new Date(TEST_NOW - 60_000).toISOString();
    const old = new Date(TEST_NOW - 8 * 24 * 60 * 60_000).toISOString();
    await worker.DB.batch([
      ["largest", "Largest!", 90, recent],
      ["ignored", "Ignored", 80, recent],
      ["lol", "LOL", 70, recent],
      ["rare", "Rare", 2, old],
      ["visible", "Visible", 12, recent],
    ].map(([word, displayWord, count, lastSeenAt]) => worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(channelId, word, count, lastSeenAt, displayWord)),
    );

    const object = channelObject(channelId) as unknown as {
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{ entries: readonly unknown[] }>;
    };

    await expect(object.readStatisticsWordRanking("total", TEST_NOW)).resolves.toMatchObject({
      entries: [
        { word: "largest", displayWord: "Largest!", count: 90 },
        { word: "visible", displayWord: "Visible", count: 12 },
      ],
    });
  });

  it("adds buffered live words to cached total candidates so a new word can overtake baseline words", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-buffered-total-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    await worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, 'baseline', 50, ?, 'Baseline')`,
    ).bind(channelId, new Date(TEST_NOW - 60_000).toISOString()).run();
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{ entries: readonly unknown[] }>;
    };

    for (let index = 0; index < 60; index += 1) await chatActivity(object, streamId, "master");

    await expect(object.readStatisticsWordRanking("total", TEST_NOW)).resolves.toMatchObject({
      entries: [
        { word: "master", displayWord: "master", count: 60 },
        { word: "baseline", displayWord: "Baseline", count: 50 },
      ],
    });
  });

  it("invalidates cached filters after statistics settings change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-settings-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    const recent = new Date(TEST_NOW - 60_000).toISOString();
    await worker.DB.batch([
      ["alpha", "Alpha", 20],
      ["beta", "Beta", 10],
    ].map(([word, displayWord, count]) => worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(channelId, word, count, recent, displayWord)));
    const object = channelObject(channelId) as unknown as {
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{ entries: readonly unknown[] }>;
      refreshStatisticsWordRankingAfterSettingsChange(): Promise<void>;
    };

    await expect(object.readStatisticsWordRanking("total", TEST_NOW)).resolves.toMatchObject({
      entries: [
        { word: "alpha", displayWord: "Alpha", count: 20 },
        { word: "beta", displayWord: "Beta", count: 10 },
      ],
    });
    await worker.DB.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'statistics'")
      .bind(JSON.stringify({ ignoredWords: ["alpha"] }), channelId).run();
    await object.refreshStatisticsWordRankingAfterSettingsChange();

    await expect(object.readStatisticsWordRanking("total", TEST_NOW + 1)).resolves.toMatchObject({
      entries: [{ word: "beta", displayWord: "Beta", count: 10 }],
    });
  });

  it("uses the last retained stream while offline and marks the snapshot offline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-offline-stream-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "stream");
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      markStatisticsWordStreamEnded(streamId: string, endedAt: string): Promise<void>;
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{
        entries: readonly unknown[]; streamIsLive?: boolean;
      }>;
    };
    await chatActivity(object, streamId, "Fak");
    await object.markStatisticsWordStreamEnded(streamId, receivedAt);
    await writeEventSubStreamState(worker.DB, channelId, "offline", new Date(Date.parse(receivedAt) + 1_000).toISOString(), null);

    await expect(object.readStatisticsWordRanking("stream", TEST_NOW)).resolves.toMatchObject({
      streamIsLive: false,
      entries: [{ word: "fak", displayWord: "Fak", count: 1 }],
    });
  });

  it("loads a ranking for an enabled standalone element outside the composition", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-standalone-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total", {}, false);
    await worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, 'standalone', 12, ?, 'Standalone')`,
    ).bind(channelId, new Date(TEST_NOW - 60_000).toISOString()).run();
    const object = channelObject(channelId) as unknown as {
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{ entries: readonly unknown[] }>;
    };

    await expect(object.readStatisticsWordRanking("total", TEST_NOW)).resolves.toMatchObject({
      entries: [{ word: "standalone", displayWord: "Standalone", count: 12 }],
    });
  });

  it("publishes a ranking from D1 on a fresh object without a bootstrap read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-cold-publish-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };

    await chatActivity(object, streamId, "freshword");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "modul.statistics.word_ranking",
      payload: { total: { entries: [{ word: "freshword", count: 1 }] } },
    });
  });

  it("publishes a standalone ranking from D1 on a fresh object", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-cold-standalone-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total", {}, false);
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };

    await chatActivity(object, streamId, "standaloneword");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "modul.statistics.word_ranking",
      payload: { total: { entries: [{ word: "standaloneword", count: 1 }] } },
    });
  });

  it("publishes a maximum-length Unicode ranking scope within the realtime payload limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-maximum-payload-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    const recent = new Date(TEST_NOW - 60_000).toISOString();
    await worker.DB.batch(Array.from({ length: 10 }, (_, index) => {
      const word = maximumUnicodeWord(index);
      return worker.DB.prepare(
        `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(channelId, word, 100 - index, recent, maximumUnicodeWord(index, true));
    }));
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };

    await chatActivity(object, streamId, "ordinaryword");

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.type).toBe("modul.statistics.word_ranking");
    if (message?.type !== "modul.statistics.word_ranking") throw new Error("Expected a ranking update.");
    const payload = message.payload as {
      stream: null;
      total: { entries: readonly { word: string; displayWord: string }[] };
    };
    expect(payload.stream).toBeNull();
    expect(payload.total.entries).toHaveLength(10);
    expect(Array.from(payload.total.entries[0]?.word ?? "")).toHaveLength(40);
    expect(payload.total.entries[0]?.word.length).toBe(80);
    expect(Array.from(payload.total.entries[0]?.displayWord ?? "")).toHaveLength(40);
    expect(payload.total.entries[0]?.displayWord.length).toBe(80);
    expect(new TextEncoder().encode(JSON.stringify(message.payload)).byteLength).toBeLessThanOrEqual(4_096);
  });

  it("publishes stream and total rankings in separate scope messages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-scope-messages-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "stream");
    await worker.DB.prepare(
      `INSERT INTO overlay_elements
         (element_id, channel_id, overlay_id, kind, label, config_json, x, y, scale_percent, z, in_composition)
       VALUES (?, ?, ?, 'statistics.word_ranking', 'Total ranking', ?, 0, 0, 100, 1, 1)`,
    ).bind(`total-element-${channelId}`, channelId, `overlay-${channelId}`, JSON.stringify({ scope: "total", count: 5, bars: true })).run();
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };

    await chatActivity(object, streamId, "master");

    expect(sent).toHaveLength(2);
    for (const message of sent) {
      if (message.type !== "modul.statistics.word_ranking") throw new Error("Expected a ranking update.");
      const payload = message.payload as { stream: unknown; total: unknown };
      expect(payload.stream === null || payload.total === null).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(message.payload)).byteLength).toBeLessThanOrEqual(4_096);
    }
    expect(sent.some((message) => message.type === "modul.statistics.word_ranking" && message.payload.stream !== null)).toBe(true);
    expect(sent.some((message) => message.type === "modul.statistics.word_ranking" && message.payload.total !== null)).toBe(true);
  });

  it("publishes word counter updates when a ranking scope is rejected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-rejected-payload-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    await worker.DB.prepare(
      `INSERT INTO overlay_elements
         (element_id, channel_id, overlay_id, kind, label, config_json, x, y, scale_percent, z, in_composition)
       VALUES (?, ?, ?, 'statistics.word_counter', 'Tracked', ?, 0, 0, 100, 1, 1)`,
    ).bind(`counter-element-${channelId}`, channelId, `overlay-${channelId}`, JSON.stringify({ word: "trackedword", label: "Tracked", show: "both" })).run();
    const oversizedWord = "ab".repeat(2_500);
    await worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, ?, 100, ?, ?)`,
    ).bind(channelId, oversizedWord, new Date(TEST_NOW - 60_000).toISOString(), oversizedWord).run();
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const sent: RealtimeMessage[] = [];
    const compute = vi.spyOn(ChannelObject.prototype as unknown as {
      computeStatisticsWordRanking(scope: "stream" | "total", now: number): Promise<unknown>;
    }, "computeStatisticsWordRanking");
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages);
      return Promise.resolve();
    });
    const object = channelObject(channelId) as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };

    await chatActivity(object, streamId, "trackedword");

    expect(compute).toHaveBeenCalledWith("total", TEST_NOW);
    expect(sent.some((message) => message.type === "modul.statistics.word_counts")).toBe(true);
    expect(sent.some((message) => message.type === "modul.statistics.word_ranking")).toBe(false);
  });

  it("publishes only changed top tens and sends the latest ranking on the trailing throttle alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-throttle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "stream");
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const object = stub as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const initialWords = ["aword", "bword", "cword", "dword", "eword", "fword", "gword", "hword", "iword", "jword"];
    for (const word of initialWords) await chatActivity(object, streamId, word);
    await vi.advanceTimersByTimeAsync(2_000);
    await runDurableObjectAlarm(stub);
    expect(sent).toHaveLength(2);
    sent.splice(0);

    await chatActivity(object, streamId, "zword");
    expect(sent).toHaveLength(0);

    await chatActivity(object, streamId, "aword");
    expect(sent).toHaveLength(0);
    await chatActivity(object, streamId, "aword");
    await vi.advanceTimersByTimeAsync(1_999);
    await runDurableObjectAlarm(stub);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await runDurableObjectAlarm(stub);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("modul.statistics.word_ranking");
    expect((sent[0]?.payload as { stream: { entries: readonly unknown[] } }).stream.entries[0])
      .toMatchObject({ word: "aword", count: 3 });
  });

  it("broadcasts the trailing ranking after a bootstrap read during the throttle window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-bootstrap-throttle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "stream");
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = stub as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<unknown>;
    };

    await chatActivity(object, streamId, "master");
    expect(sent).toHaveLength(1);
    await chatActivity(object, streamId, "master");
    expect(sent).toHaveLength(1);
    await statisticsWordRankingOverlayElement.initialState?.(
      worker.DB,
      channelId,
      { scope: "stream", count: 5, bars: true },
      {
        now: TEST_NOW,
        readStatisticsWordRanking: (scope: "stream" | "total", now: number) =>
          object.readStatisticsWordRanking(scope, now),
      } as unknown as ModuleOverlayElementContext,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await runDurableObjectAlarm(stub);

    expect(sent).toHaveLength(2);
    expect((sent[1]?.payload as { stream: { entries: readonly unknown[] } }).stream.entries[0])
      .toMatchObject({ word: "master", count: 2 });
  });

  it("limits unchanged ranking computations and recomputes once on the trailing alarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-computation-throttle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    const recent = new Date(TEST_NOW - 60_000).toISOString();
    await worker.DB.batch(Array.from({ length: 10 }, (_, index) => worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, ?, 100, ?, ?)`,
    ).bind(channelId, `baseline${String(index)}`, recent, `Baseline ${String(index)}`)));
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const object = stub as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
    };
    const compute = vi.spyOn(ChannelObject.prototype as unknown as {
      computeStatisticsWordRanking(scope: "stream" | "total", now: number): Promise<unknown>;
    }, "computeStatisticsWordRanking");

    await chatActivity(object, streamId, "triggerword");
    compute.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    for (const word of ["outsideone", "outsidetwo", "outsidethree", "outsidefour", "outsidefive"]) {
      await chatActivity(object, streamId, word);
    }

    expect(compute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await runDurableObjectAlarm(stub);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("reloads ranking scopes before an invalidated alarm flush", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-alarm-scope-reload-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "stream");
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = stub as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      invalidateStatisticsWordRankingScopes(): void;
    };

    await chatActivity(object, streamId, "firstword");
    await chatActivity(object, streamId, "secondword");
    object.invalidateStatisticsWordRankingScopes();
    await vi.advanceTimersByTimeAsync(2_000);
    await runDurableObjectAlarm(stub);

    expect(sent).toHaveLength(2);
    expect((sent[1]?.payload as { stream: { entries: readonly unknown[] } }).stream.entries[0])
      .toMatchObject({ word: "firstword", count: 1 });
    expect((sent[1]?.payload as { stream: { entries: readonly unknown[] } }).stream.entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({ word: "secondword", count: 1 })]));
  });

  it("backs off repeated ranking computation failures before last-computed is stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-computation-retry-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    const stub = channelObject(channelId);
    const compute = vi.spyOn(ChannelObject.prototype as unknown as {
      computeStatisticsWordRanking(scope: "stream" | "total", now: number): Promise<unknown>;
    }, "computeStatisticsWordRanking").mockRejectedValue(new Error("ranking query unavailable"));
    const readAlarm = (): Promise<{ deadline: number; nextAttemptAt?: number } | undefined> =>
      runInDurableObject(stub, (_durableObject, state) => {
        const table = state.storage.kv.get<Record<string, { deadline: number; nextAttemptAt?: number }>>(
          "channel:alarm_schedule",
        ) ?? {};
        return table["statistics:word_counter_publish"];
      });

    // Inside the object: a rejection crossing the stub would surface as an unhandled rejection in the runner.
    await runInDurableObject(stub, async (durableObject) => {
      const target = durableObject as unknown as {
        queueStatisticsWordCounterChanges(words: readonly string[], refreshRanking?: boolean): Promise<void>;
      };
      await expect(target.queueStatisticsWordCounterChanges([], true))
        .rejects.toThrow("ranking query unavailable");
    });
    await runInDurableObject(stub, async (_durableObject, state) => {
      await expect(state.storage.get("statistics:word_counter_last_computed")).resolves.toBeUndefined();
    });
    const firstRetry = await readAlarm();
    expect((firstRetry?.nextAttemptAt ?? firstRetry?.deadline ?? 0) - TEST_NOW).toBeGreaterThanOrEqual(2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    await runFailingAlarm(stub);
    expect(compute).toHaveBeenCalledTimes(2);
    const secondRetry = await readAlarm();
    expect((secondRetry?.nextAttemptAt ?? secondRetry?.deadline ?? 0) - Date.now()).toBeGreaterThanOrEqual(2_000);

    await vi.advanceTimersByTimeAsync(1_999);
    await runFailingAlarm(stub);
    expect(compute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await runFailingAlarm(stub);
    expect(compute).toHaveBeenCalledTimes(3);
    const thirdRetry = await readAlarm();
    expect((thirdRetry?.nextAttemptAt ?? thirdRetry?.deadline ?? 0) - Date.now()).toBeGreaterThanOrEqual(2_000);
  });

  it("does not read ranking baselines or publish without a ranking element", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-no-element-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages);
      return Promise.resolve();
    });

    await runInDurableObject(stub, async (durableObject) => {
      const object = durableObject as unknown as {
        env: Env;
        recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      };
      const prepare = vi.spyOn(object.env.DB, "prepare");
      await chatActivity(object, streamId, "ordinaryword");
      expect(prepare.mock.calls.some(([sql]) => sql.includes("channel_word_frequency_baseline"))).toBe(false);
      // Only the one scope lookup may mention the ranking element; no ranking computation or recipient query runs.
      const rankingQueries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("statistics.word_ranking"));
      expect(rankingQueries).toHaveLength(1);
      expect(rankingQueries[0]).toContain("SELECT config_json FROM overlay_elements");
      prepare.mockRestore();
    });

    expect(sent.some((message) => message.type === "modul.statistics.word_ranking")).toBe(false);
  });

  it("invalidates ranking scopes when a ranking element is added or removed", async () => {
    const channelId = `statistics-ranking-scope-invalidation-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const now = new Date(TEST_NOW).toISOString();
    const overlayId = `overlay-${channelId}`;
    await worker.DB.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
       VALUES (?, ?, 'Word ranking cache', 800, 450, '', 1, ?, ?)`,
    ).bind(overlayId, channelId, now, now).run();
    const stub = channelObject(channelId);
    await runInDurableObject(stub, async (durableObject) => {
      const object = durableObject as unknown as {
        env: Env;
        readStatisticsWordRankingScopes(): Promise<Set<string>>;
        publish(messages: readonly RealtimeMessage[]): Promise<void>;
      };
      const changed = (): RealtimeMessage => ({
        version: 1,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        channelId,
        type: "overlay.changed",
        payload: { overlayId, revision: 2 },
      });
      const add = async (config: Record<string, unknown>): Promise<void> => {
        await object.env.DB.prepare(
          `INSERT INTO overlay_elements
             (element_id, channel_id, overlay_id, kind, label, config_json, x, y, scale_percent, z, in_composition)
           VALUES (?, ?, ?, 'statistics.word_ranking', 'Ranking', ?, 0, 0, 100, 0, 1)
           ON CONFLICT(element_id) DO UPDATE SET config_json = excluded.config_json`,
        ).bind(`element-${channelId}`, channelId, overlayId, JSON.stringify(config)).run();
        await object.publish([changed()]);
      };

      await add({ scope: "stream", count: 5, bars: true });
      await expect(object.readStatisticsWordRankingScopes()).resolves.toEqual(new Set(["stream"]));
      await add({ scope: "total", count: 5, bars: true });
      await expect(object.readStatisticsWordRankingScopes()).resolves.toEqual(new Set(["total"]));
      await object.env.DB.prepare("UPDATE overlay_elements SET in_composition = 0 WHERE element_id = ?")
        .bind(`element-${channelId}`).run();
      await object.publish([changed()]);
      await expect(object.readStatisticsWordRankingScopes()).resolves.toEqual(new Set(["total"]));
      await object.env.DB.prepare("UPDATE overlay_elements SET in_composition = 1 WHERE element_id = ?")
        .bind(`element-${channelId}`).run();
      await add({ scope: "total", count: 2, bars: true });
      await expect(object.readStatisticsWordRankingScopes()).resolves.toEqual(new Set());
      await object.env.DB.prepare("DELETE FROM overlay_elements WHERE element_id = ?").bind(`element-${channelId}`).run();
      await object.publish([changed()]);
      await expect(object.readStatisticsWordRankingScopes()).resolves.toEqual(new Set());
    });
  });

  it("refreshes a cached total ranking after an ended stream batch merges", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-ranking-baseline-merge-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordRanking(channelId, "total");
    await worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, 'baseline', 100, ?, 'Baseline')`,
    ).bind(channelId, new Date(TEST_NOW - 60_000).toISOString()).run();
    // Mark the fixture baseline as already folded so the merge keeps its display spelling.
    await worker.DB.prepare(
      "INSERT OR REPLACE INTO channel_word_frequency_baseline_folded (channel_id, folded_at) VALUES (?, ?)",
    ).bind(channelId, new Date(TEST_NOW - 60_000).toISOString()).run();
    const streamId = `ranking-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_ranking"));
      return Promise.resolve();
    });
    const object = stub as unknown as {
      recordChatActivity: Parameters<typeof chatActivity>[0]["recordChatActivity"];
      markStatisticsWordStreamEnded(streamId: string, endedAt: string): Promise<void>;
      readStatisticsWordRanking(scope: "stream" | "total", now?: number): Promise<{ entries: readonly unknown[] }>;
      runModuleAlarm(moduleId: string, handlerKey: string, alarmKey: string): Promise<unknown>;
    };
    for (let index = 0; index < 10; index += 1) await chatActivity(object, streamId, "master");
    await object.markStatisticsWordStreamEnded(streamId, receivedAt);
    await writeEventSubStreamState(worker.DB, channelId, "offline", new Date(Date.parse(receivedAt) + 1_000).toISOString(), null);
    await expect(object.readStatisticsWordRanking("total", TEST_NOW)).resolves.toMatchObject({
      entries: [{ word: "baseline", displayWord: "Baseline", count: 100 }],
    });

    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await object.runModuleAlarm("statistics", "window", "window");

    // The first chat message of the fresh object publishes immediately; the merge refresh is the second message.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toMatchObject({
      total: { entries: [
        { word: "baseline", displayWord: "Baseline", count: 100 },
        { word: "master", displayWord: "master", count: 10 },
      ] },
    });
  });
});
