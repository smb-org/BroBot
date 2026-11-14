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
});
