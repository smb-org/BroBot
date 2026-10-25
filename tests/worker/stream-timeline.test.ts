import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { postConfirmedClipLink } from "../../src/worker/clip";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { writeEventSubStreamState } from "../../src/worker/db/stream-state";
import { eventSubRouter } from "../../src/worker/eventsub";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

// Real D1 and the real channel Durable Object: the EventSub router, the dispatcher, the clip
// confirmation and the statistics window alarm all write the timeline through the shipped code.
const worker = env as unknown as Env;
const encoder = new TextEncoder();
const WINDOW_MS = 300_000;
const iso = (time: number): string => new Date(time).toISOString();
const stubs = new Set<DurableObjectStub>();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const signedNotification = async (messageId: string, body: string, timestamp: string): Promise<Request> => {
  const ring = JSON.parse(worker.TWITCH_EVENTSUB_SECRET) as { active: { key: string } };
  const key = await crypto.subtle.importKey("raw", encoder.encode(ring.active.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${messageId}${timestamp}${body}`)));
  return new Request("https://brobot.example/api/twitch/eventsub", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": "notification",
    },
  });
};

const deliver = async (type: string, channelId: string, messageId: string, at: number, event: Record<string, unknown>) => {
  const body = JSON.stringify({
    subscription: { type, version: "1", condition: { broadcaster_user_id: channelId } },
    event: { broadcaster_user_id: channelId, ...event },
  });
  const result = await eventSubRouter.fetch(await signedNotification(messageId, body, iso(at)), worker);
  expect(result.status).toBe(204);
};

const timelineRows = async (channelId: string, kind: string) => (await worker.DB.prepare(
  `SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events
    WHERE channel_id = ? AND kind = ? ORDER BY occurred_at`,
).bind(channelId, kind).all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>()).results;

describe("stream timeline against D1 and the channel object", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await Promise.all([...stubs].map((stub) => runInDurableObject(stub, async (_object, state) => {
      await state.storage.deleteAlarm();
    })));
    stubs.clear();
  });

  it("records one drop for online, offline, online within ten minutes, also after redelivery", async () => {
    const channelId = "timeline-drop";
    await insertPointChannel(channelId);
    const now = Date.now();
    const streamEvent = { id: "stream-1", started_at: iso(now - 30 * 60_000) };

    await deliver("stream.online", channelId, "drop-online-1", now - 8 * 60_000, streamEvent);
    await deliver("stream.offline", channelId, "drop-offline-1", now - 5 * 60_000, {});
    await deliver("stream.online", channelId, "drop-online-2", now - 1_000, streamEvent);
    // The same EventSub message again, once through the router and once straight into the dispatcher.
    await deliver("stream.online", channelId, "drop-online-2", now - 1_000, streamEvent);
    await dispatchEventSubNotification(worker, {
      channelId,
      subscriptionType: "stream.online",
      triggerId: "drop-online-2",
      payload: { broadcaster_user_id: channelId, ...streamEvent },
      receivedAt: iso(now),
      eventSubTimestamp: iso(now - 1_000),
    });

    expect(await timelineRows(channelId, "stream_online")).toHaveLength(2);
    expect(await timelineRows(channelId, "stream_offline")).toHaveLength(1);
    const drops = await timelineRows(channelId, "stream_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ stream_id: "stream-1" });
    expect(JSON.parse(drops[0]?.detail_json ?? "{}")).toEqual({ gapSeconds: 299 });
  });

  it("does not mark a gap longer than ten minutes as a drop", async () => {
    const channelId = "timeline-no-drop";
    await insertPointChannel(channelId);
    const base = Date.now() - 9 * 60_000;
    const dispatch = (type: string, triggerId: string, at: number) => dispatchEventSubNotification(worker, {
      channelId,
      subscriptionType: type,
      triggerId,
      payload: { id: "stream-9", started_at: iso(base) },
      receivedAt: iso(at),
      eventSubTimestamp: iso(at),
    });
    await dispatch("stream.online", "gap-online-1", base);
    await dispatch("stream.offline", "gap-offline-1", base + 60_000);
    await dispatch("stream.online", "gap-online-2", base + 60_000 + 11 * 60_000);

    expect(await timelineRows(channelId, "stream_drop")).toEqual([]);
  });

  it("detects a title change once, with the previous title", async () => {
    const channelId = "timeline-title";
    await insertPointChannel(channelId);
    const now = Date.now();

    await deliver("channel.update", channelId, "title-1", now - 120_000, { title: "First", category_id: "", category_name: "" });
    await deliver("channel.update", channelId, "title-2", now - 60_000, { title: "Second", category_id: "", category_name: "" });
    await deliver("channel.update", channelId, "title-2", now - 60_000, { title: "Second", category_id: "", category_name: "" });
    // A different message that repeats the current title is not a change.
    await deliver("channel.update", channelId, "title-3", now - 30_000, { title: "Second", category_id: "", category_name: "" });

    const rows = await timelineRows(channelId, "title_change");
    expect(rows.map((row) => JSON.parse(row.detail_json) as unknown)).toEqual([
      { oldTitle: null, newTitle: "First" },
      { oldTitle: "First", newTitle: "Second" },
    ]);
  });

  it("writes one clip event with only the clip id, even when the confirmation is retried", async () => {
    const channelId = "timeline-clip";
    await insertPointChannel(channelId);
    const confirmed = {
      created: true,
      reason: null,
      detail: { status: 200, confirmationStatus: 200 },
      clipId: "clip-worker-1",
      editUrl: "https://clips.twitch.tv/clip-worker-1/edit",
      title: "Moment",
      url: "https://clips.twitch.tv/clip-worker-1",
    };
    const settings = { postClipLinkInChat: false, chatLinkTemplate: "Clip: {clip.url}" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await postConfirmedClipLink(worker, channelId, "creator-user-7", settings, confirmed, vi.fn<typeof fetch>(), "clip-trigger-1");
    }

    const rows = await timelineRows(channelId, "clip_created");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail_json).toBe(JSON.stringify({ clipId: "clip-worker-1" }));
    expect(JSON.stringify(rows)).not.toContain("creator-user-7");
  });

  it("writes ad breaks only for a channel whose broadcaster granted the ads scope", async () => {
    const consented = "timeline-ads-yes";
    const anonymous = "timeline-ads-no";
    await insertPointChannel(consented);
    await insertPointChannel(anonymous);
    const now = new Date().toISOString();
    await worker.DB.prepare(
      `INSERT INTO twitch_login_identity
         (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'a', 'r', ?, 'connected', ?, ?)`,
    ).bind(consented, consented, JSON.stringify(["channel:read:ads"]), now, now, now).run();
    const started = Date.now() - 20_000;

    for (const channelId of [consented, anonymous]) {
      await deliver("channel.ad_break.begin", channelId, `ad-${channelId}`, started, {
        started_at: iso(started),
        duration_seconds: 90,
        is_automatic: true,
      });
      await deliver("channel.ad_break.begin", channelId, `ad-${channelId}`, started, {
        started_at: iso(started),
        duration_seconds: 90,
        is_automatic: true,
      });
    }

    const rows = await timelineRows(consented, "ad_break");
    expect(rows.map((row) => JSON.parse(row.detail_json) as unknown)).toEqual([
      { durationSeconds: 90, startedAt: iso(started) },
    ]);
    expect(await timelineRows(anonymous, "ad_break")).toEqual([]);
  });

  it("writes an emote spike once per window across repeated window alarms", async () => {
    const channelId = "timeline-spike";
    await insertPointChannel(channelId);
    const spikeStart = Math.floor((Date.now() - 20 * 60_000) / WINDOW_MS) * WINDOW_MS;
    const insertWindow = (windowStart: number, emotes: number) => worker.DB.prepare(
      `INSERT INTO channel_statistics (channel_id, stream_id, window_start, messages, emotes)
       VALUES (?, 'stream-1', ?, 1, ?)`,
    ).bind(channelId, iso(windowStart), emotes).run();
    for (let index = 1; index <= 4; index += 1) await insertWindow(spikeStart - index * WINDOW_MS, 2);

    await writeEventSubStreamState(worker.DB, channelId, "offline", iso(spikeStart + 250_000), null);

    const stub = worker.CHANNEL.get(worker.CHANNEL.idFromName(channelId));
    stubs.add(stub);
    const message = (offset: number, emotes: number) => ({
      windowStart: iso(spikeStart),
      receivedAt: iso(spikeStart + offset),
      emotes,
      streamId: "stream-1",
    });
    await stub.recordChatActivity("viewer-1", true, message(90_000, 12));
    // The scheduled window alarm sits on the past boundary, so it runs right away.
    await runDurableObjectAlarm(stub);
    // A late message dirties the same window again; the retried flush must not add a second spike.
    await stub.recordChatActivity("viewer-2", true, message(150_000, 1));
    await runDurableObjectAlarm(stub);
    expect((await worker.DB.prepare(
      "SELECT emotes FROM channel_statistics WHERE channel_id = ? AND window_start = ?",
    ).bind(channelId, iso(spikeStart)).first<{ emotes: number }>())?.emotes).toBe(13);

    const rows = await timelineRows(channelId, "emote_spike");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurred_at).toBe(iso(spikeStart + WINDOW_MS));
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
      windowStart: iso(spikeStart),
      emotes: 12,
      medianEmotes: 2,
      baselineWindows: 4,
    });
    expect(rows[0]?.detail_json).not.toContain("viewer-1");
  });
});
