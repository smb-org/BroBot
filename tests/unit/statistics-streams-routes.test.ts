import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import type { ModuleTimelineEvent } from "../../src/modules/contract";
import { statisticsRoutes } from "../../src/modules/statistics/routes";
import { writeChannelTimelineEvent } from "../../src/worker/db/timeline-events";
import { requireChannelAuthorization } from "../../src/worker/auth/guards";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "statistics-streams-channel";
const USER_ID = "statistics-streams-user";
const cookieKeys = JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] });
const encryptionKeys = JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] });
const databases: TestD1Database[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T23:59:00.000Z"));
});

const appFor = (): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("/channels/:channelId/modules/statistics/*", requireChannelAuthorization());
  app.route("/channels/:channelId/modules/statistics", statisticsRoutes);
  return app;
};

const setup = async (member = true): Promise<{ database: TestD1Database; fetch: (path: string) => Promise<Response> }> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await insertLoginIdentityAndSession(database, USER_ID);
  if (member) await insertMember(database, CHANNEL_ID, USER_ID, "manager");
  const sessionCookie = await createSessionCookie({ sessionId: `session-${USER_ID}` }, cookieKeys, encryptionKeys);
  const app = appFor();
  const environment = {
    DB: database as unknown as D1Database,
    SESSION_COOKIE_KEYS: cookieKeys,
    SESSION_ENCRYPTION_KEYS: encryptionKeys,
  } as Env;
  return {
    database,
    fetch: async (path) => await app.fetch(new Request(`https://brobot.example${path}`, {
      headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
    }), environment),
  };
};

const putWindow = async (
  database: TestD1Database,
  streamId: string | null,
  windowStart: string,
  values: { messages?: number; emotes?: number; viewers?: number | null; chatters?: number | null; activeChatters?: number | null } = {},
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_statistics
      (channel_id, stream_id, window_start, messages, emotes, viewer_count, chatters, active_chatters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    CHANNEL_ID,
    streamId,
    windowStart,
    values.messages ?? 10,
    values.emotes ?? 2,
    values.viewers === undefined ? 100 : values.viewers,
    values.chatters === undefined ? 20 : values.chatters,
    values.activeChatters === undefined ? 5 : values.activeChatters,
  ).run();
};

const putTimeline = async (
  database: TestD1Database,
  key: string,
  kind: string,
  occurredAt: string,
  detail: Readonly<Record<string, unknown>> = {},
  streamId: string | null = null,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_timeline_events (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(CHANNEL_ID, key, streamId, occurredAt, kind, JSON.stringify(detail)).run();
};

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("statistics stream routes", () => {
  it("denies a non-member before returning any channel statistics", async () => {
    const { fetch } = await setup(false);
    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams`);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
  });

  it("lists aggregated streams newest first and follows an opaque cursor", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "stream-old", "2026-10-24T18:00:00.000Z", { viewers: 20 });
    await putWindow(database, "stream-new", "2026-10-25T18:00:00.000Z", { viewers: 40 });
    await putWindow(database, null, "2026-10-25T18:05:00.000Z", { messages: 999 });
    await putTimeline(database, "online-old", "stream_online", "2026-10-24T18:00:00.000Z", {}, "stream-old");
    await putTimeline(database, "online-new", "stream_online", "2026-10-25T18:00:00.000Z", {}, "stream-new");
    await putTimeline(database, "metadata-old", "channel_metadata", "2026-10-24T18:01:00.000Z", {
      title: "Yesterday", category: { id: "1", name: "Game One" },
    });

    const firstResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams?limit=1`);
    const first = await firstResponse.json<{ streams: Array<{ streamId: string; title: string | null }>; nextCursor: string | null }>();
    expect(firstResponse.status).toBe(200);
    expect(first.streams.map(({ streamId }) => streamId)).toEqual(["stream-new"]);
    expect(first.nextCursor).not.toBeNull();

    const secondResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    const second = await secondResponse.json<{ streams: Array<{ streamId: string; title: string | null }>; nextCursor: string | null }>();
    expect(second.streams).toEqual([expect.objectContaining({ streamId: "stream-old", title: "Yesterday" })]);
    expect(second.nextCursor).toBeNull();
  });

  it("lists and opens streams from statistics windows without a stream-online row", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "window-only", "2026-10-25T12:00:00.000Z", { messages: 35 });

    const listResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams`);
    const list = await listResponse.json<{ streams: Array<{ streamId: string; messages: number }> }>();
    const detailResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/window-only`);
    const detail = await detailResponse.json<{ summary: { streamId: string; messages: number }; windows: unknown[] }>();

    expect(listResponse.status).toBe(200);
    expect(list.streams).toEqual([expect.objectContaining({ streamId: "window-only", messages: 35 })]);
    expect(detailResponse.status).toBe(200);
    expect(detail).toMatchObject({ summary: { streamId: "window-only", messages: 35 }, windows: [expect.any(Object)] });
  });

  it("reads every selected stream window while paging by its latest window", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "stream-a", "2026-10-25T12:00:00.000Z", { messages: 10 });
    await putWindow(database, "stream-a", "2026-10-25T12:05:00.000Z", { messages: 20 });
    await putWindow(database, "stream-b", "2026-10-25T12:10:00.000Z", { messages: 50 });

    const firstResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams?limit=1`);
    const first = await firstResponse.json<{ streams: Array<{ streamId: string; messages: number }>; nextCursor: string | null }>();
    const secondResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
    const second = await secondResponse.json<{ streams: Array<{ streamId: string; messages: number }>; nextCursor: string | null }>();

    expect(first.streams).toEqual([expect.objectContaining({ streamId: "stream-b", messages: 50 })]);
    expect(first.nextCursor).not.toBeNull();
    expect(second.streams).toEqual([expect.objectContaining({ streamId: "stream-a", messages: 30 })]);
    expect(second.nextCursor).toBeNull();
  });

  it("uses inclusive window bounds for events and keeps a same-id reconnect in one stream", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "reconnected-stream", "2026-10-25T12:00:00.000Z");
    await putWindow(database, "reconnected-stream", "2026-10-25T12:05:00.000Z");
    await putTimeline(database, "online", "stream_online", "2026-10-25T12:00:00.000Z", {}, "reconnected-stream");
    await putTimeline(database, "offline", "stream_offline", "2026-10-25T12:01:00.000Z");
    await putTimeline(database, "reconnect", "stream_online", "2026-10-25T12:02:00.000Z", {}, "reconnected-stream");
    await putTimeline(database, "clip-before-end", "clip_created", "2026-10-25T12:09:59.999999999Z", { clipId: "clip-before-end" });
    await putTimeline(database, "clip-at-end", "clip_created", "2026-10-25T12:10:00.000000000Z", { clipId: "clip-at-end" });
    await putTimeline(database, "clip-after-end", "clip_created", "2026-10-25T12:10:00.000000001Z", { clipId: "clip-after-end" });
    await putTimeline(database, "spike-last-window", "emote_spike", "2026-10-25T12:10:00.000000000Z", {
      windowStart: "2026-10-25T12:05:00.000Z", emotes: 40,
    });
    await putTimeline(database, "spike-other-window", "emote_spike", "2026-10-25T12:08:00.000000000Z", {
      windowStart: "2026-10-25T12:04:00.000Z", emotes: 99,
    });

    const listResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams`);
    const list = await listResponse.json<{ streams: Array<{ streamId: string; startedAt: string; endedAt: string; clips: number }> }>();
    const detailResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/reconnected-stream`);
    const detail = await detailResponse.json<{
      summary: { startedAt: string; endedAt: string; clips: number };
      events: Array<{ type: string; at: string; clipId?: string; emotes?: number; recoveredAt?: string }>;
    }>();

    expect(list.streams).toEqual([expect.objectContaining({
      streamId: "reconnected-stream",
      startedAt: "2026-10-25T12:00:00.000Z",
      endedAt: "2026-10-25T12:10:00.000Z",
      clips: 2,
    })]);
    expect(detailResponse.status).toBe(200);
    expect(detail.summary).toMatchObject({ startedAt: "2026-10-25T12:00:00.000Z", endedAt: "2026-10-25T12:10:00.000Z", clips: 2 });
    expect(detail.events).toContainEqual(expect.objectContaining({ type: "drop", at: "2026-10-25T12:01:00.000Z", recoveredAt: "2026-10-25T12:02:00.000Z" }));
    expect(detail.events.filter(({ type }) => type === "clip").map(({ clipId }) => clipId)).toEqual(["clip-before-end", "clip-at-end"]);
    expect(detail.events.filter(({ type }) => type === "emoteSpike").map(({ emotes }) => emotes)).toEqual([40]);
  });

  it("seeds list and detail metadata from the latest observation before the stream", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "metadata-stream", "2026-10-25T12:00:00.000Z");
    await putTimeline(database, "metadata-before", "channel_metadata", "2026-10-25T11:50:00.000Z", {
      title: "Scheduled title", category: { id: "seed", name: "Seed game" },
    });
    await putTimeline(database, "metadata-online", "stream_online", "2026-10-25T12:00:00.000Z", {}, "metadata-stream");
    await putTimeline(database, "metadata-live", "channel_metadata", "2026-10-25T12:02:00.000Z", {
      title: "Live title", category: { id: "live", name: "Live game" },
    });

    const listResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams`);
    const list = await listResponse.json<{ streams: Array<{ title: string | null; categories: string[] }> }>();
    const detailResponse = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/metadata-stream`);
    const detail = await detailResponse.json<{ summary: { title: string | null; categories: string[] } }>();

    expect(list.streams[0]).toMatchObject({ title: "Live title", categories: ["Seed game", "Live game"] });
    expect(detailResponse.status).toBe(200);
    expect(detail.summary).toMatchObject({ title: "Live title", categories: ["Seed game", "Live game"] });
  });

  it("reads canonical nanosecond timeline timestamps at window boundaries", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "precise-stream", "2026-10-25T12:00:00.000Z");
    const online: Extract<ModuleTimelineEvent, { kind: "stream_online" }> = {
      kind: "stream_online",
      identity: "precise-online",
      occurredAt: "2026-10-25T12:00:00.000Z",
      streamId: "precise-stream",
      detail: { startedAt: "2026-10-25T12:00:00.000Z" },
    };
    await writeChannelTimelineEvent(database as unknown as D1Database, CHANNEL_ID, online);
    const stored = await database.prepare(
      "SELECT occurred_at FROM channel_timeline_events WHERE channel_id = ? AND kind = 'stream_online'",
    ).bind(CHANNEL_ID).first<{ occurred_at: string }>();

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/precise-stream`);
    const body = await response.json<{ events: Array<{ type: string }> }>();

    expect(stored?.occurred_at).toBe("2026-10-25T12:00:00.000000000Z");
    expect(body.events).toContainEqual(expect.objectContaining({ type: "start" }));
  });

  it("returns stream windows, time-matched BELABOX history, and derived timeline events", async () => {
    const { database, fetch } = await setup();
    await putWindow(database, "stream-detail", "2026-10-25T12:00:00.000Z", { viewers: 80, messages: 10 });
    await putWindow(database, "stream-detail", "2026-10-25T12:05:00.000Z", { viewers: 90, messages: 20, emotes: 7 });
    await putTimeline(database, "online", "stream_online", "2026-10-25T12:00:00.000Z", {}, "stream-detail");
    await putTimeline(database, "metadata-a", "channel_metadata", "2026-10-25T12:01:00.000Z", {
      title: "Opening", category: { name: "Game One" },
    });
    await putTimeline(database, "metadata-b", "channel_metadata", "2026-10-25T12:04:00.000Z", {
      title: "Main show", category: { name: "Game Two" },
    });
    await putTimeline(database, "offline", "stream_offline", "2026-10-25T12:06:00.000Z");
    await putTimeline(database, "reconnect", "stream_online", "2026-10-25T12:09:00.000Z", {}, "stream-detail");
    await putTimeline(database, "clip", "clip_created", "2026-10-25T12:03:00.000Z", { clipId: "clip-1" });
    await database.prepare(
      `INSERT INTO belabox_bitrate_windows
        (channel_id, stream_id, window_start, bitrate_min, bitrate_max, bitrate_avg, bitrate_p10, rtt_avg, dropped_delta, sample_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "separate-belabox-id", Date.parse("2026-10-25T12:00:00.000Z"), 4_000, 6_000, 5_400, 5_000, 40, 0, 3).run();

    const response = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/stream-detail`);
    const body = await response.json<{
      summary: { title: string | null; categories: string[]; clips: number };
      windows: Array<{ viewerCount: number | null; messages: number }>;
      bitrateWindows: Array<{ bitrateAvg: number }>;
      events: Array<{ type: string; title?: string | null; oldTitle?: string | null }>;
    }>();

    expect(response.status).toBe(200);
    expect(body.summary).toMatchObject({ title: "Main show", categories: ["Game One", "Game Two"], clips: 1 });
    expect(body.windows).toEqual([
      expect.objectContaining({ viewerCount: 80, messages: 10 }),
      expect.objectContaining({ viewerCount: 90, messages: 20 }),
    ]);
    expect(body.bitrateWindows).toEqual([expect.objectContaining({ bitrateAvg: 5_400 })]);
    expect(body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "metadata", oldTitle: "Opening", title: "Main show" }),
      expect.objectContaining({ type: "drop" }),
      expect.objectContaining({ type: "clip" }),
    ]));
    expect(JSON.stringify(body)).not.toMatch(/user_?id|login/iu);
  });

  it("validates query and path parameters with zod", async () => {
    const { fetch } = await setup();
    const invalidLimit = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams?limit=1000`);
    const invalidStreamId = await fetch(`/channels/${CHANNEL_ID}/modules/statistics/streams/%20`);

    expect(invalidLimit.status).toBe(400);
    expect(invalidStreamId.status).toBe(400);
  });
});
