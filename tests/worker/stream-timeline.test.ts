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
// Stored timeline timestamps keep a fixed nine-digit fraction.
const ns = (time: number): string => iso(time).replace(/Z$/u, "000000Z");
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

  it("stores raw lifecycle rows and deduplicates a redelivery with a different message id", async () => {
    const channelId = "timeline-drop";
    await insertPointChannel(channelId);
    const now = Date.now();
    const streamEvent = { id: "stream-1", started_at: iso(now - 30 * 60_000) };

    await deliver("stream.online", channelId, "drop-online-1", now - 8 * 60_000, streamEvent);
    await deliver("stream.offline", channelId, "drop-offline-1", now - 5 * 60_000, {});
    await deliver("stream.online", channelId, "drop-online-2", now - 1_000, streamEvent);
    // A different EventSub message can redeliver the same lifecycle fact.
    await deliver("stream.online", channelId, "drop-online-redelivery", now - 1_000, streamEvent);
    await dispatchEventSubNotification(worker, {
      channelId,
      subscriptionType: "stream.online",
      triggerId: "drop-online-redelivery",
      payload: { broadcaster_user_id: channelId, ...streamEvent },
      receivedAt: iso(now),
      eventSubTimestamp: iso(now - 1_000),
    });

    expect(await timelineRows(channelId, "stream_online")).toHaveLength(2);
    expect(await timelineRows(channelId, "stream_offline")).toHaveLength(1);
    const lifecycle = await worker.DB.prepare(
      `SELECT kind, stream_id, occurred_at, detail_json FROM channel_timeline_events
        WHERE channel_id = ? ORDER BY occurred_at`,
    ).bind(channelId).all<{ kind: string; stream_id: string | null; occurred_at: string; detail_json: string }>();
    expect(lifecycle.results).toEqual([
      { kind: "stream_online", stream_id: "stream-1", occurred_at: ns(now - 8 * 60_000), detail_json: JSON.stringify({ startedAt: streamEvent.started_at }) },
      { kind: "stream_offline", stream_id: null, occurred_at: ns(now - 5 * 60_000), detail_json: "{}" },
      { kind: "stream_online", stream_id: "stream-1", occurred_at: ns(now - 1_000), detail_json: JSON.stringify({ startedAt: streamEvent.started_at }) },
    ]);
  });

  it("stores lifecycle rows once when messages arrive out of order and keeps stream_id for online only", async () => {
    const channelId = "timeline-out-of-order";
    await insertPointChannel(channelId);
    const now = Date.now();
    const streamEvent = { id: "stream-7", started_at: iso(now - 20 * 60_000) };

    // The offline message is delivered first, the older online message second, then both again.
    await deliver("stream.offline", channelId, "ooo-offline", now - 2_000, {});
    await deliver("stream.online", channelId, "ooo-online", now - 9 * 60_000, streamEvent);
    await deliver("stream.offline", channelId, "ooo-offline-again", now - 2_000, {});
    await deliver("stream.online", channelId, "ooo-online-again", now - 9 * 60_000, streamEvent);

    const rows = (await worker.DB.prepare(
      `SELECT kind, stream_id, occurred_at FROM channel_timeline_events
        WHERE channel_id = ? ORDER BY occurred_at`,
    ).bind(channelId).all<{ kind: string; stream_id: string | null; occurred_at: string }>()).results;
    expect(rows).toEqual([
      { kind: "stream_online", stream_id: "stream-7", occurred_at: ns(now - 9 * 60_000) },
      { kind: "stream_offline", stream_id: null, occurred_at: ns(now - 2_000) },
    ]);
  });

  it("keeps Twitch nanosecond order for metadata observations within one millisecond", async () => {
    const channelId = "timeline-nanoseconds";
    await insertPointChannel(channelId);
    const second = iso(Date.now() - 2_000).slice(0, 19);
    const dispatch = (triggerId: string, title: string, fraction: string) => dispatchEventSubNotification(worker, {
      channelId,
      subscriptionType: "channel.update",
      triggerId,
      payload: { title, category_id: "", category_name: "" },
      receivedAt: iso(Date.now()),
      eventSubTimestamp: `${second}.${fraction}Z`,
    });

    // Delivered in reverse: the later observation (.123900000) arrives first.
    await dispatch("ns-later", "Later", "123900000");
    await dispatch("ns-earlier", "Earlier", "123100000");

    const rows = await timelineRows(channelId, "channel_metadata");
    expect(rows.map((row) => row.occurred_at)).toEqual([`${second}.123100000Z`, `${second}.123900000Z`]);
    expect(rows.map((row) => (JSON.parse(row.detail_json) as { title: string }).title)).toEqual(["Earlier", "Later"]);
  });

  it("keeps stream_id null on late non-online events while a stream is current", async () => {
    const channelId = "timeline-late-events";
    await insertPointChannel(channelId);
    await writeEventSubStreamState(worker.DB, channelId, "online", iso(Date.now()), iso(Date.now()), "current-stream");
    const now = Date.now();

    await deliver("channel.update", channelId, "late-update", now - 5_000, { title: "Late", category_id: "g1", category_name: "Game" });
    await deliver("stream.offline", channelId, "late-offline", now - 4_000, {});

    const rows = (await worker.DB.prepare(
      "SELECT kind, stream_id FROM channel_timeline_events WHERE channel_id = ? ORDER BY occurred_at",
    ).bind(channelId).all<{ kind: string; stream_id: string | null }>()).results;
    expect(rows).toEqual([
      { kind: "channel_metadata", stream_id: null },
      { kind: "stream_offline", stream_id: null },
    ]);
  });

  it("keeps processing the stream state when the timeline write fails", async () => {
    const channelId = "timeline-write-failure";
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      `CREATE TRIGGER timeline_write_failure BEFORE INSERT ON channel_timeline_events
         WHEN NEW.channel_id = 'timeline-write-failure'
       BEGIN SELECT RAISE(ABORT, 'injected timeline failure'); END`,
    ).run();
    try {
      await deliver("stream.online", channelId, "failure-online", Date.now() - 1_000, {
        id: "stream-9",
        started_at: iso(Date.now() - 60_000),
      });
    } finally {
      await worker.DB.prepare("DROP TRIGGER timeline_write_failure").run();
    }

    expect(await timelineRows(channelId, "stream_online")).toEqual([]);
    const state = await worker.DB.prepare(
      "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?",
    ).bind(channelId).first<{ state: string; stream_id: string | null }>();
    expect(state).toEqual({ state: "online", stream_id: "stream-9" });
  });

  it("stores current metadata observations, including an empty category", async () => {
    const channelId = "timeline-title";
    await insertPointChannel(channelId);
    const now = Date.now();

    await deliver("channel.update", channelId, "title-1", now - 120_000, { title: "First", category_id: "", category_name: "" });
    await deliver("channel.update", channelId, "title-2", now - 60_000, { title: "Second", category_id: "game-2", category_name: "Category" });
    // A different message id carrying the same observation is a redelivery of the same fact.
    await deliver("channel.update", channelId, "title-2-redelivery", now - 60_000, { title: "Second", category_id: "game-2", category_name: "Category" });
    await deliver("channel.update", channelId, "title-3", now - 30_000, { title: "Second", category_id: "", category_name: "" });
    await deliver("channel.update", channelId, "title-3", now - 30_000, { title: "Second", category_id: "", category_name: "" });

    const rows = await timelineRows(channelId, "channel_metadata");
    expect(rows.map((row) => JSON.parse(row.detail_json) as unknown)).toEqual([
      { title: "First", category: null },
      { title: "Second", category: { id: "game-2", name: "Category" } },
      { title: "Second", category: null },
    ]);
    expect(rows.every((row) => row.stream_id === null)).toBe(true);
  });

  it("writes one unassociated clip event even when a stream is current and confirmation is retried", async () => {
    const channelId = "timeline-clip";
    await insertPointChannel(channelId);
    await writeEventSubStreamState(worker.DB, channelId, "online", iso(Date.now()), iso(Date.now()), "current-stream");
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
    expect(rows[0]?.stream_id).toBeNull();
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
    expect(rows[0]?.stream_id).toBeNull();
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
    expect(rows[0]?.stream_id).toBeNull();
    expect(rows[0]?.occurred_at).toBe(ns(spikeStart + WINDOW_MS));
    expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
      windowStart: iso(spikeStart),
      emotes: 12,
      medianEmotes: 2,
      baselineWindows: 4,
    });
    expect(rows[0]?.detail_json).not.toContain("viewer-1");
  });
});
