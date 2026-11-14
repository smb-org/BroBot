import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ModuleOverlayElementContext } from "../../src/modules/contract";
import { statisticsModule } from "../../src/modules/statistics";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { hydrateModuleOverlayElements } from "../../src/worker/overlays/module-state";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
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

const seedWordCounter = async (channelId: string, word: string, inComposition = true): Promise<void> => {
  const now = new Date(TEST_NOW).toISOString();
  const overlayId = `overlay-${channelId}`;
  await worker.DB.batch([
    worker.DB.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
       VALUES (?, ?, 'Word counter test', 800, 450, '', 1, ?, ?)`,
    ).bind(overlayId, channelId, now, now),
    worker.DB.prepare(
      `INSERT INTO overlay_elements
         (element_id, channel_id, overlay_id, kind, label, config_json, x, y, scale_percent, z, in_composition)
       VALUES (?, ?, ?, 'statistics.word_counter', ?, ?, 0, 0, 100, 0, ?)`,
    ).bind(`element-${channelId}`, channelId, overlayId, word, JSON.stringify({ word, label: word, show: "both" }), inComposition ? 1 : 0),
  ]);
}

const deferred = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

beforeAll(runMigrations);

afterEach(async () => {
  await Promise.all([...stubs].map((stub) => runInDurableObject(stub, async (_object, state) => {
    await state.storage.deleteAlarm();
  })));
  stubs.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("statistics word counter worker state", () => {
  it("filters untracked words and publishes the trailing count no sooner than two seconds later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-counter-throttle-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordCounter(channelId, "fak", false);
    const streamId = `word-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      // The alarm drain also publishes unrelated panel messages.
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_counts"));
      return Promise.resolve();
    });
    const object = stub as unknown as {
      recordChatActivity(
        chatterUserId: string | null,
        needsActiveChatters: boolean,
        statistics: { windowStart: string; receivedAt: string; emotes: number; streamId: string; textFragments: readonly string[] },
      ): Promise<number>;
    };
    const activity = (text: string) => object.recordChatActivity(null, false, {
      windowStart: new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString(),
      receivedAt: new Date(Date.now()).toISOString(),
      emotes: 0,
      streamId,
      textFragments: [text],
    });

    await activity("spareword");
    expect(sent).toHaveLength(0);
    await activity("fak");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("modul.statistics.word_counts");
    expect(sent[0]?.payload).toMatchObject({ words: { fak: { streamCount: 1, totalCount: 1, streamIsLive: true } } });

    await activity("fak");
    await activity("fak");
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    await runDurableObjectAlarm(stub);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await runDurableObjectAlarm(stub);

    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toMatchObject({ words: { fak: { streamCount: 3, totalCount: 3, streamIsLive: true } } });
  });

  it("hydrates current word counts when the overlay reconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-counter-reconnect-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordCounter(channelId, "fak");
    const streamId = `word-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(Date.now()).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const object = stub as unknown as {
      recordChatActivity(
        chatterUserId: string | null,
        needsActiveChatters: boolean,
        statistics: { windowStart: string; receivedAt: string; emotes: number; streamId: string; textFragments: readonly string[] },
      ): Promise<number>;
      readStatisticsWordCountForLookup(streamId: string | undefined, word: string): Promise<unknown>;
    };
    await object.recordChatActivity(null, false, {
      windowStart: new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString(),
      receivedAt,
      emotes: 0,
      streamId,
      textFragments: ["fak fak"],
    });

    const initialStateContext = {
      now: Date.now(),
      language: "en",
      readStatisticsWordCountForLookup: (selectedStreamId: string | undefined, word: string) =>
        object.readStatisticsWordCountForLookup(selectedStreamId, word),
    } as unknown as ModuleOverlayElementContext;
    const hydrated = await hydrateModuleOverlayElements(worker.DB, channelId, [{
      id: `element-${channelId}`,
      kind: "statistics.word_counter",
      config: { word: "fak", label: "fak", show: "both" },
    }], [statisticsModule], initialStateContext);

    expect(hydrated[0]).toMatchObject({
      moduleEnabled: true,
      state: { words: { fak: { streamCount: 1, totalCount: 1, streamIsLive: true } } },
    });
  });

  it("publishes a tracked total after a baseline merge without later chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEST_NOW);
    const channelId = `statistics-counter-merge-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordCounter(channelId, "fak");
    await worker.DB.prepare(
      `INSERT INTO channel_word_frequency_baseline (channel_id, word, total_count, last_seen_at, display_word)
       VALUES (?, 'fak', 100, ?, 'fak')`,
    ).bind(channelId, new Date(TEST_NOW - 30 * 60_000).toISOString()).run();
    const streamId = `word-stream-${crypto.randomUUID()}`;
    const receivedAt = new Date(TEST_NOW - 20 * 60_000).toISOString();
    await writeEventSubStreamState(worker.DB, channelId, "online", receivedAt, receivedAt, streamId);
    const stub = channelObject(channelId);
    const sent: RealtimeMessage[] = [];
    vi.spyOn(ChannelObject.prototype, "publish").mockImplementation((messages) => {
      sent.push(...messages.filter((message) => message.type === "modul.statistics.word_counts"));
      return Promise.resolve();
    });
    const object = stub as unknown as {
      recordChatActivity(
        chatterUserId: string | null,
        needsActiveChatters: boolean,
        statistics: { windowStart: string; receivedAt: string; emotes: number; streamId: string; textFragments: readonly string[] },
      ): Promise<number>;
      markStatisticsWordStreamEnded(streamId: string, endedAt: string): Promise<void>;
      runModuleAlarm(moduleId: string, handlerKey: string, alarmKey: string): Promise<unknown>;
    };

    for (let index = 0; index < 10; index += 1) {
      await object.recordChatActivity(null, false, {
        windowStart: receivedAt,
        receivedAt,
        emotes: 0,
        streamId,
        textFragments: ["fak"],
      });
    }
    await vi.advanceTimersByTimeAsync(2_000);
    await runDurableObjectAlarm(stub);
    sent.length = 0;

    const endedAt = new Date(Date.now()).toISOString();
    await object.markStatisticsWordStreamEnded(streamId, endedAt);
    await writeEventSubStreamState(worker.DB, channelId, "offline", endedAt, null);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    await object.runModuleAlarm("statistics", "window", "window");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      words: { fak: { streamCount: 10, totalCount: 110, streamIsLive: false } },
    });
  });

  it("discards a tracked-word cache fill invalidated while its query is pending", async () => {
    const channelId = `statistics-counter-cache-race-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await seedWordCounter(channelId, "fak");
    const stub = channelObject(channelId);
    // Everything runs inside one Durable Object callback: separate callbacks would be serialized and
    // the object's own D1 binding cannot be observed from the test isolate's context.
    await runInDurableObject(stub, async (durableObject) => {
    const object = durableObject as unknown as {
      env: Env;
      readStatisticsWordCounterTrackedWords(): Promise<Set<string>>;
      publish(messages: readonly RealtimeMessage[]): Promise<void>;
    };
    const database = object.env.DB;
    const firstQueryStarted = deferred();
    const releaseFirstQuery = deferred();
    const originalPrepare = database.prepare.bind(database);
    let trackedWordQueries = 0;
    const databasePrepare = vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SELECT DISTINCT CASE WHEN json_valid(element.config_json)")) return statement;
      trackedWordQueries += 1;
      if (trackedWordQueries !== 1) return statement;

      return new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              const originalAll = bound.all.bind(bound);
              return new Proxy(bound, {
                get(boundTarget, boundProperty) {
                  if (boundProperty === "all") {
                    return async () => {
                      const result = await originalAll();
                      firstQueryStarted.resolve();
                      await releaseFirstQuery.promise;
                      return result;
                    };
                  }
                  return Reflect.get(boundTarget, boundProperty, boundTarget) as unknown;
                },
              });
            };
          }
          return Reflect.get(target, property, target) as unknown;
        },
      });
    });

    const firstRead = object.readStatisticsWordCounterTrackedWords();
    await firstQueryStarted.promise;
    const secondRead = object.readStatisticsWordCounterTrackedWords();
    expect(trackedWordQueries).toBe(1);

    await database.prepare(
      "UPDATE overlay_elements SET config_json = ? WHERE channel_id = ? AND kind = 'statistics.word_counter'",
    ).bind(JSON.stringify({ word: "bak", label: "bak", show: "both" }), channelId).run();
    const changed: RealtimeMessage = {
      version: 1,
      id: `overlay-change-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      channelId,
      type: "overlay.changed",
      payload: { overlayId: `overlay-${channelId}`, revision: 2 },
    };
    await object.publish([changed]);
    releaseFirstQuery.resolve();

    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
      new Set(["bak"]),
      new Set(["bak"]),
    ]);
    expect(trackedWordQueries).toBe(2);
    databasePrepare.mockRestore();
    });
  });
});
