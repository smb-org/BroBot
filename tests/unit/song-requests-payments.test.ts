import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext, ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import type { SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import { processSongRequestsEvent, refundRequestId, songRequestRefundOperationId } from "../../src/modules/song_requests/service";
import { transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-requests-payment-fixture";
const NOW = "2026-11-15T20:10:00.000Z";
const track = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover-one", width: 640, height: 640 }] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};
const databases: TestD1Database[] = [];

const createHarness = async (
  rawSettings: unknown,
  options: { pointsEnabled?: boolean; explicit?: boolean; failCharge?: boolean } = {},
) => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  const settings = songRequestsSettingsSchema.parse(rawSettings);
  const settingsJson = JSON.stringify(settings);
  await database.batch([
    database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, ?)")
      .bind(CHANNEL_ID, settingsJson),
    database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'points', ?, '{}')")
      .bind(CHANNEL_ID, options.pointsEnabled === false ? 0 : 1),
    database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, 'operator', ?)")
      .bind(CHANNEL_ID, NOW),
    database.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', 'stream-payment-fixture')")
      .bind(CHANNEL_ID, NOW),
    database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(CHANNEL_ID, NOW),
  ]);
  const operations = new Map<string, { kind: string; result: unknown }>();
  const apply = vi.fn((operationId: string, kind: string, _movements: unknown[], result: unknown) => {
    if (kind === "stake" && options.failCharge === true) return Promise.reject(new Error("insufficient_points"));
    if (operations.has(operationId)) return Promise.resolve({ result: operations.get(operationId)?.result });
    operations.set(operationId, { kind, result });
    return Promise.resolve({ result });
  });
  const points = {
    apply,
    getOperation: vi.fn((operationId: string) => Promise.resolve(operations.get(operationId) ?? null)),
  } as unknown as ModulePointsAccess;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ tracks: { items: [{ ...track, explicit: options.explicit ?? false }] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const scheduledAlarms: string[] = [];
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    environment: {
      APP_ENV: "local",
      SPOTIFY_API_BASE: "http://spotify.mock/v1",
      CHANNEL: { idFromName: (name: string) => name, get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fixture") }) },
    },
    points,
    channelLanguage: () => Promise.resolve("en"),
    botUserId: () => Promise.resolve("bot-fixture"),
    scheduleAlarm: (_handlerKey: string, alarmKey: string) => { scheduledAlarms.push(alarmKey); return Promise.resolve(); },
  } as unknown as ModuleExecutionContext;
  const createEvent = (login: string, chatStatus: ModuleEvent<SongRequestsSettings>["chatStatus"] = ["viewer"]): ModuleEvent<SongRequestsSettings> => ({
    channelId: CHANNEL_ID,
    subscriptionType: "channel.chat.message",
    triggerId: `message-${login}`,
    payload: {
      chatter_user_id: `user-${login}`,
      chatter_user_login: login,
      chatter_user_name: `Viewer ${login}`,
      message_id: `message-${login}`,
      message: { text: "!sr Glass Harbor", fragments: [{ type: "text", text: "!sr Glass Harbor" }] },
    },
    settings,
    receivedAt: NOW,
    actor: null,
    chatStatus,
  });
  return { database, context, points, operations, scheduledAlarms, fetcher, apply, createEvent };
};

const removeAppFor = (points: ModulePointsAccess) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "operator");
    context.set("points", () => points);
    context.set("publishModuleOverlayMessage", vi.fn(() => Promise.resolve()));
    await next();
  });
  app.route("/channels/:channelId", songRequestsRoutes);
  return app;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("song request payments", () => {
  it("accepts a free request above its role threshold with points disabled and never charges or refunds it", async () => {
    const harness = await createHarness({ mode: "moderated", paymentMode: "free", freeRoleThreshold: "subscriber" }, { pointsEnabled: false });
    const rejected = await processSongRequestsEvent(harness.createEvent("juniper_viewer", ["viewer"]), harness.context);
    expect(rejected.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(harness.apply).not.toHaveBeenCalled();
    expect(await harness.database.prepare("SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ count: 0 });

    const accepted = await processSongRequestsEvent(harness.createEvent("maple_viewer", ["subscriber"]), harness.context);
    expect(accepted.actions[0]).toMatchObject({ kind: "chat", automated: false });
    const row = await harness.database.prepare("SELECT id, request_type, charged_amount, state FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; request_type: string; charged_amount: number; state: string }>();
    expect(row).toMatchObject({ request_type: "free", charged_amount: 0, state: "pending_review" });
    if (row === null) throw new Error("The free request was not recorded.");
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: row.id, fromState: "pending_review", toState: "rejected", now: NOW,
    });
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it("charges a paid admission after insert and applies a refund operation at most once", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", botPointsCost: 13, mode: "automatic" });
    const result = await processSongRequestsEvent(harness.createEvent("cedar_viewer"), harness.context);
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(harness.apply).toHaveBeenCalledTimes(1);
    expect(harness.apply.mock.calls[0]?.[0]).toContain(":charge");
    expect(harness.apply.mock.calls[0]?.[1]).toBe("stake");
    expect(harness.apply.mock.calls[0]?.[2]).toEqual([{ accountId: "user-cedar_viewer", login: "cedar_viewer", delta: -13 }]);
    const row = await harness.database.prepare("SELECT id, state, charged_amount FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string; charged_amount: number }>();
    expect(row).toMatchObject({ state: "approved", charged_amount: 13 });
    if (row === null) throw new Error("The paid request was not recorded.");
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: row.id, fromState: "approved", toState: "rejected", now: NOW,
    });
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    expect(harness.apply).toHaveBeenCalledTimes(2);
    expect(harness.apply.mock.calls[1]?.[0]).toContain(":refund");
    expect(harness.apply.mock.calls[1]?.[1]).toBe("refund");
  });

  it("rejects a charged pre-submission request and refunds it", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" });
    await processSongRequestsEvent(harness.createEvent("pre_submit_viewer"), harness.context);
    const row = await harness.database.prepare("SELECT id, state FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string }>();
    if (row === null) throw new Error("The moderated request was not recorded.");
    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refund: false }),
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "rejected", refunded: true });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "rejected" });
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(true);
  });

  it("removes a submitted request without refund unless the moderator chooses the refund action", async () => {
    const withoutRefund = await createHarness({ paymentMode: "bot_points", mode: "automatic" });
    await processSongRequestsEvent(withoutRefund.createEvent("remove_without_refund"), withoutRefund.context);
    const first = await withoutRefund.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (first === null) throw new Error("The paid request was not recorded.");
    await transitionRequest(withoutRefund.database as unknown as D1Database, { channelId: CHANNEL_ID, requestId: first.id, fromState: "approved", toState: "submitting", now: NOW });
    await transitionRequest(withoutRefund.database as unknown as D1Database, { channelId: CHANNEL_ID, requestId: first.id, fromState: "submitting", toState: "submitted", now: NOW });
    const noRefundResponse = await removeAppFor(withoutRefund.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${first.id}/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refund: false }),
    }), { DB: withoutRefund.database as unknown as D1Database });
    expect(noRefundResponse.status).toBe(200);
    expect(await noRefundResponse.json()).toEqual({ state: "removed", refunded: false });
    expect(withoutRefund.operations.has(songRequestRefundOperationId(first.id))).toBe(false);
    expect(withoutRefund.apply).toHaveBeenCalledTimes(1);

    const withRefund = await createHarness({ paymentMode: "bot_points", mode: "automatic" });
    await processSongRequestsEvent(withRefund.createEvent("remove_with_refund"), withRefund.context);
    const second = await withRefund.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (second === null) throw new Error("The second paid request was not recorded.");
    await transitionRequest(withRefund.database as unknown as D1Database, { channelId: CHANNEL_ID, requestId: second.id, fromState: "approved", toState: "submitting", now: NOW });
    await transitionRequest(withRefund.database as unknown as D1Database, { channelId: CHANNEL_ID, requestId: second.id, fromState: "submitting", toState: "submitted", now: NOW });
    const refundResponse = await removeAppFor(withRefund.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${second.id}/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refund: true }),
    }), { DB: withRefund.database as unknown as D1Database });
    expect(refundResponse.status).toBe(200);
    expect(await refundResponse.json()).toEqual({ state: "removed", refunded: true });
    expect(withRefund.operations.has(songRequestRefundOperationId(second.id))).toBe(true);
    expect(withRefund.apply).toHaveBeenCalledTimes(2);
  });

  it("marks a failed charge as failed and does not schedule Spotify submission", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "automatic" }, { failCharge: true });
    const result = await processSongRequestsEvent(harness.createEvent("willow_viewer"), harness.context);
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(harness.scheduledAlarms).toHaveLength(0);
    expect(await harness.database.prepare("SELECT state, charged_amount FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ state: "failed", charged_amount: 0 });
  });

  it("does not charge when an admission rule rejects the track", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", rules: { explicitAllowed: false } }, { explicit: true });
    const result = await processSongRequestsEvent(harness.createEvent("ash_viewer"), harness.context);
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(result.actions[0])).toContain("explicit tracks are not allowed");
    expect(harness.apply).not.toHaveBeenCalled();
    expect(await harness.database.prepare("SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ count: 0 });
  });

  it("keeps bot point requests unavailable while the points module is disabled", async () => {
    const harness = await createHarness({ paymentMode: "bot_points" }, { pointsEnabled: false });
    const result = await processSongRequestsEvent(harness.createEvent("elm_viewer"), harness.context);
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(result.actions[0])).toContain("points module is disabled");
    expect(harness.apply).not.toHaveBeenCalled();
  });
});
