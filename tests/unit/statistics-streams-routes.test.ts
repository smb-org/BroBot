import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { statisticsRoutes } from "../../src/modules/statistics/routes";
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
