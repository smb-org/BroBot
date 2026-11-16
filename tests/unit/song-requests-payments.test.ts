import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext, ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import type { SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import { processSongRequestsEvent, refundRequestId, retrySongRequestRefunds, songRequestRefundOperationId } from "../../src/modules/song_requests/service";
import { cleanupSongRequestRound, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
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
  options: {
    pointsEnabled?: boolean;
    explicit?: boolean;
    failCharge?: boolean;
    beforeChargeCommit?: () => Promise<void>;
    failRefundAttempts?: number;
  } = {},
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
  let failRefundAttempts = options.failRefundAttempts ?? 0;
  // In-memory ledger with the real rules: movements must sum to zero and only the house may go negative.
  const balances = new Map<string, number>();
  const balanceOf = (accountId: string): number => balances.get(accountId) ?? (accountId === "__house" ? 0 : 1_000);
  const applyMovements = (movements: unknown[]): void => {
    const deltas = movements as { accountId: string; delta: number }[];
    if (deltas.reduce((sum, movement) => sum + movement.delta, 0) !== 0) throw new Error("ledger_not_zero_sum");
    const next = new Map<string, number>();
    for (const { accountId, delta } of deltas) next.set(accountId, (next.get(accountId) ?? balanceOf(accountId)) + delta);
    for (const [accountId, balance] of next) if (accountId !== "__house" && balance < 0) throw new Error("insufficient_balance");
    for (const [accountId, balance] of next) balances.set(accountId, balance);
  };
  const apply = vi.fn(async (operationId: string, kind: string, movements: unknown[], result: unknown) => {
    if (kind === "stake") await options.beforeChargeCommit?.();
    if (kind === "stake" && options.failCharge === true) return Promise.reject(new Error("insufficient_points"));
    if (kind === "refund" && failRefundAttempts > 0) {
      failRefundAttempts -= 1;
      throw new Error("temporary_refund_failure");
    }
    if (operations.has(operationId)) return Promise.resolve({ result: operations.get(operationId)?.result });
    applyMovements(movements);
    operations.set(operationId, { kind, result });
    return { result };
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
  return { database, context, points, operations, scheduledAlarms, fetcher, apply, createEvent, balanceOf };
};

const removeAppFor = (points: ModulePointsAccess) => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "operator");
    context.set("points", () => points);
    context.set("publishModuleOverlayMessage", vi.fn(() => Promise.resolve()));
    context.set("scheduleModuleAlarm", vi.fn(() => Promise.resolve()));
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
      channelId: CHANNEL_ID, requestId: row.id, fromState: "pending_review", toState: "rejected", refundDue: true, now: NOW,
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
    expect(harness.apply.mock.calls[0]?.[2]).toEqual([
      { accountId: "user-cedar_viewer", login: "cedar_viewer", delta: -13 },
      { accountId: "__house", delta: 13 },
    ]);
    const row = await harness.database.prepare("SELECT id, state, charged_amount FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string; charged_amount: number }>();
    expect(row).toMatchObject({ state: "approved", charged_amount: 13 });
    if (row === null) throw new Error("The paid request was not recorded.");
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: row.id, fromState: "approved", toState: "rejected", refundDue: true, now: NOW,
    });
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    expect(harness.apply).toHaveBeenCalledTimes(2);
    expect(harness.apply.mock.calls[1]?.[0]).toContain(":refund");
    expect(harness.apply.mock.calls[1]?.[1]).toBe("refund");
    expect(harness.apply.mock.calls[1]?.[2]).toEqual([
      { accountId: "user-cedar_viewer", login: "cedar_viewer", delta: 13 },
      { accountId: "__house", delta: -13 },
    ]);
    expect(harness.balanceOf("user-cedar_viewer")).toBe(1_000);
    expect(harness.balanceOf("__house")).toBe(0);
  });

  it("refunds once when moderation rejects before the charge commits", async () => {
    let releaseCharge!: () => void;
    let signalChargeStarted!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeStarted = new Promise<void>((resolve) => { signalChargeStarted = resolve; });
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" }, {
      beforeChargeCommit: async () => {
        signalChargeStarted();
        await chargeGate;
      },
    });
    const command = processSongRequestsEvent(harness.createEvent("race_viewer"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The moderated request was not recorded.");

    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/reject`, {
      method: "POST",
    }), { DB: harness.database as unknown as D1Database });
    expect(response.status).toBe(200);
    releaseCharge();
    const result = await command;

    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(result.actions[0])).toContain("rejected");
    expect(JSON.stringify(result.actions[0])).not.toContain("accepted");
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund")).toHaveLength(1);
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(true);
    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?")
      .bind(row.id).first()).toEqual({ state: "rejected", refund_due: 0 });
  });

  it("reconciles a terminal refund after cleanup could no longer select the row", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" }, { failRefundAttempts: 2 });
    await processSongRequestsEvent(harness.createEvent("retry_refund_viewer"), harness.context);
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The moderated request was not recorded.");

    const cleanup = await cleanupSongRequestRound(
      harness.database as unknown as D1Database,
      CHANNEL_ID,
      "stream-payment-fixture",
      NOW,
      "list_cleared",
    );
    expect(cleanup.refundableRequestIds).toContain(row.id);
    await expect(refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id))
      .rejects.toThrow("temporary_refund_failure");
    expect(await harness.database.prepare("SELECT refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ refund_due: 1 });

    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refund: false }),
    }), { DB: harness.database as unknown as D1Database });
    expect(response.status).toBe(409);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund")).toHaveLength(2);
    expect(await harness.database.prepare("SELECT refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ refund_due: 1 });

    await retrySongRequestRefunds({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points });
    expect(await harness.database.prepare("SELECT refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ refund_due: 0 });
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(true);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund")).toHaveLength(3);
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
