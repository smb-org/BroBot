import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

// These tests run the real Durable Object SQLite statements and the real module alarm handler; only
// the clock is the machine clock, so every window sits a few minutes in the past.
const worker = env as unknown as Env;
const WINDOW_MS = 300_000;
const iso = (time: number): string => new Date(time).toISOString();
const stubs = new Set<DurableObjectStub>();

const statisticsObject = (channelId: string) => {
  const stub = worker.CHANNEL.get(worker.CHANNEL.idFromName(channelId));
  stubs.add(stub);
  return stub;
};

// The RPC type of an `unknown` result is not thenable for the linter, but the call is a promise.
const runWindowAlarm = async (object: ReturnType<typeof statisticsObject>): Promise<void> => {
  await (object.runModuleAlarm("statistics", "window", "window") as unknown as Promise<unknown>);
};

const pastWindowStart = (): number => Math.floor((Date.now() - 20 * 60_000) / WINDOW_MS) * WINDOW_MS;

const statisticsRows = async (channelId: string) => (await worker.DB.prepare(
  `SELECT stream_id, window_start, window_seconds, messages, emotes, viewer_count, chatters, active_chatters
     FROM channel_statistics WHERE channel_id = ? ORDER BY window_start`,
).bind(channelId).all()).results;

describe("statistics windows in the channel object", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    // A scheduled platform alarm must not fire after the test body.
    await Promise.all([...stubs].map((stub) => runInDurableObject(stub, async (_object, state) => {
      await state.storage.deleteAlarm();
    })));
    stubs.clear();
  });

  it("writes the offline partial window with absolute totals and raises it for a late message", async () => {
    const channelId = "statistics-window-offline";
    await insertPointChannel(channelId);
    const windowStart = pastWindowStart();
    const startedAt = windowStart + 60_000;
    const endedAt = windowStart + 200_000;
    await writeEventSubStreamState(worker.DB, channelId, "offline", iso(endedAt), null);
    const object = statisticsObject(channelId);
    const message = (offset: number, emotes: number) => ({
      windowStart: iso(windowStart),
      receivedAt: iso(windowStart + offset),
      emotes,
      streamId: "stream-1",
    });

    await object.startStatisticsOnlineSegment(iso(startedAt), "stream-1");
    await object.recordChatActivity("viewer-1", true, message(90_000, 2));
    await object.recordChatActivity("viewer-2", true, message(120_000, 2));
    await runWindowAlarm(object);

    const first = await statisticsRows(channelId);
    expect(first).toEqual([{
      stream_id: "stream-1",
      window_start: iso(windowStart),
      window_seconds: 140,
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
    expect(Number(late?.window_seconds)).toBeGreaterThanOrEqual(140);
  });

  it("keeps one window per epoch slot across an offline/online flap and sums the online seconds", async () => {
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

    await object.startStatisticsOnlineSegment(iso(windowStart + 10_000), "stream-1");
    await object.recordChatActivity(null, false, message(20_000));
    await object.stopStatisticsOnlineSegment(iso(windowStart + 110_000));
    await object.startStatisticsOnlineSegment(iso(windowStart + 150_000), "stream-2");
    await object.recordChatActivity(null, false, message(160_000));
    await runWindowAlarm(object);

    expect(await statisticsRows(channelId)).toMatchObject([{
      window_start: iso(windowStart),
      window_seconds: 100 + 100,
      messages: 2,
    }]);
  });
});
