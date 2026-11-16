import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import type { SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import { handleSongRequestsActivation, handleSubmitAlarm, pollSongRequestsPlayback, processSongRequestsEvent, reconcileStaleSongRequestCharges, refundRequestId, retrySongRequestRefunds, songRequestChargeOperationId, songRequestRefundOperationId } from "../../src/modules/song_requests/service";
import { cleanupSongRequestRound, pendingSongRequestQueue, recentSongRequests, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { readSongRequestQueueState } from "../../src/modules/song_requests/overlay/queue-state";
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
    language?: "de" | "en";
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
  const operations = new Map<string, { kind: string; result: unknown; movements: string; payloadFingerprint: string }>();
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
  const apply = vi.fn(async (operationId: string, kind: string, movements: unknown[], result: unknown, payloadIdentity?: unknown) => {
    if (kind === "stake") await options.beforeChargeCommit?.();
    if (kind === "stake" && options.failCharge === true) return Promise.reject(new Error("insufficient_points"));
    if (kind === "refund" && movements.length > 0 && failRefundAttempts > 0) {
      failRefundAttempts -= 1;
      throw new Error("temporary_refund_failure");
    }
    const serializedMovements = JSON.stringify(movements);
    const payloadFingerprint = payloadIdentity === undefined
      ? JSON.stringify({ result })
      : JSON.stringify({ identity: payloadIdentity });
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.kind !== kind || existing.movements !== serializedMovements || existing.payloadFingerprint !== payloadFingerprint) {
        throw new Error("operation_conflict");
      }
      return { result: existing.result };
    }
    applyMovements(movements);
    operations.set(operationId, { kind, result, movements: serializedMovements, payloadFingerprint });
    return { result };
  });
  const points = {
    apply,
    getOperation: vi.fn((operationId: string) => Promise.resolve(operations.get(operationId) ?? null)),
  } as unknown as ModulePointsAccess;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ tracks: { items: [{ ...track, explicit: options.explicit ?? false }] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
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
    channelLanguage: () => Promise.resolve(options.language ?? "en"),
    botUserId: () => Promise.resolve("bot-fixture"),
    scheduleAlarm: (_handlerKey: string, alarmKey: string) => { scheduledAlarms.push(alarmKey); return Promise.resolve(); },
  } as unknown as ModuleExecutionContext;
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({
    sent: true,
    reason: null,
    retryable: false,
    delivery: "delivered",
  }));
  const alarmContext = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    points,
    environment: context.environment,
    secrets: {
      readWithVersion: () => Promise.resolve({
        value: JSON.stringify({ accessToken: "spotify-access-fixture", refreshToken: "spotify-refresh-fixture", expiresAt: Date.now() + 600_000 }),
        version: "fixture-version",
      }),
    },
    streamState: () => Promise.resolve("online"),
    streamStartedAt: () => Promise.resolve({ streamId: "stream-payment-fixture", startedAt: NOW }),
    channelLanguage: () => Promise.resolve(options.language ?? "en"),
    sendChat,
    schedule: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    getAlarmDeadline: vi.fn(() => Promise.resolve(null)),
    publishModuleOverlayMessage: vi.fn(() => Promise.resolve()),
  } as unknown as ModuleAlarmContext;
  const createEvent = (login: string, chatStatus: ModuleEvent<SongRequestsSettings>["chatStatus"] = ["viewer"], receivedAt = NOW): ModuleEvent<SongRequestsSettings> => ({
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
    receivedAt,
    actor: null,
    chatStatus,
  });
  return { database, context, alarmContext, points, operations, scheduledAlarms, fetcher, apply, sendChat, createEvent, balanceOf };
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
    expect(harness.apply).toHaveBeenCalledTimes(3);
    expect(harness.apply.mock.calls[1]?.[0]).toBe(songRequestChargeOperationId(row.id));
    expect(harness.apply.mock.calls[1]?.[1]).toBe("refund");
    expect(harness.apply.mock.calls[1]?.[2]).toEqual([]);
    expect(harness.apply.mock.calls[2]?.[0]).toBe(songRequestRefundOperationId(row.id));
    expect(harness.apply.mock.calls[2]?.[2]).toEqual([
      { accountId: "user-cedar_viewer", login: "cedar_viewer", delta: 13 },
      { accountId: "__house", delta: -13 },
    ]);
    expect(harness.balanceOf("user-cedar_viewer")).toBe(1_000);
    expect(harness.balanceOf("__house")).toBe(0);
  });

  it("keeps a late Spotify POST completion terminal after cleanup and refunds the ledger charge once", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "automatic" });
    const result = await processSongRequestsEvent(harness.createEvent("late_post_viewer"), harness.context);
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The paid request was not recorded.");

    let releasePost!: (response: Response) => void;
    let signalPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { signalPostStarted = resolve; });
    const postResponse = new Promise<Response>((resolve) => { releasePost = resolve; });
    harness.fetcher.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("me/player/queue")) {
        signalPostStarted();
        return await postResponse;
      }
      return new Response(JSON.stringify({ tracks: { items: [{ ...track }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const submit = handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`);
    await postStarted;

    const cleanup = await cleanupSongRequestRound(
      harness.database as unknown as D1Database,
      CHANNEL_ID,
      "stream-payment-fixture",
      NOW,
      "list_cleared",
    );
    expect(cleanup.refundableRequestIds).toContain(row.id);
    await retrySongRequestRefunds({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points });
    releasePost(new Response(null, { status: 204 }));
    await submit;

    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?")
      .bind(row.id).first()).toEqual({ state: "failed", refund_due: 0 });
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(true);
  });

  it.each([
    ["de", "Der Song könnte in Spotify eingereiht worden sein; bitte prüfe Spotify vor einem erneuten Versuch."],
    ["en", "The song may have been queued in Spotify; check Spotify before retrying."],
  ] as const)("keeps a disabled pending submission uncertain in %s", async (language, expectedMessage) => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "automatic" }, { language });
    await processSongRequestsEvent(harness.createEvent(`disable_pending_${language}`), harness.context);
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The paid request was not recorded.");

    let releasePost!: (response: Response) => void;
    let signalPostStarted!: () => void;
    const postStarted = new Promise<void>((resolve) => { signalPostStarted = resolve; });
    const postResponse = new Promise<Response>((resolve) => { releasePost = resolve; });
    harness.fetcher.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("me/player/queue")) {
        signalPostStarted();
        return await postResponse;
      }
      return new Response(JSON.stringify({ tracks: { items: [{ ...track }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const submit = handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`);
    await postStarted;
    await harness.database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).run();

    await handleSongRequestsActivation(harness.alarmContext, false);
    expect(await harness.database.prepare("SELECT state, failure_reason, refund_due FROM song_requests WHERE id = ?")
      .bind(row.id).first()).toEqual({ state: "failed", failure_reason: "submit_outcome_uncertain", refund_due: 0 });
    expect(harness.balanceOf(`user-disable_pending_${language}`)).toBe(1_000);

    releasePost(new Response(null, { status: 204 }));
    await submit;
    expect(harness.sendChat).toHaveBeenCalledWith(
      expectedMessage,
      expect.any(String),
      undefined,
      undefined,
      undefined,
      { automated: true },
    );
    expect(harness.sendChat.mock.calls[0]?.[0]).not.toContain("not queued in Spotify");
    expect(await harness.database.prepare("SELECT state, failure_reason, refund_due FROM song_requests WHERE id = ?")
      .bind(row.id).first()).toEqual({ state: "failed", failure_reason: "submit_outcome_uncertain", refund_due: 0 });
    expect(harness.balanceOf(`user-disable_pending_${language}`)).toBe(1_000);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
  });

  it.each([true, false])("keeps the uncertain outcome when a moderator removes an unclear send (refund %s)", async (refund) => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "automatic" }, { language: "en" });
    await processSongRequestsEvent(harness.createEvent(`unclear_removal_${String(refund)}`), harness.context);
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The paid request was not recorded.");
    harness.fetcher.mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("me/player/queue")) return Promise.reject(new TypeError("Connection closed after Spotify accepted the queue command."));
      return Promise.resolve(new Response(JSON.stringify({ tracks: { items: [{ ...track }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    harness.sendChat.mockResolvedValueOnce({ sent: false, reason: "rate_limited", retryable: true, delivery: "not_attempted" });

    await expect(handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`)).rejects.toThrow("waiting for chat delivery");
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "outcome_unknown" });

    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refund }),
    }), { DB: harness.database as unknown as D1Database });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "removed", refunded: refund });
    expect(await harness.database.prepare("SELECT state, failure_reason FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "removed", failure_reason: "submit_outcome_uncertain" });
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(refund ? 1 : 0);

    await handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`);
    expect(harness.sendChat).toHaveBeenLastCalledWith(
      "The song may have been queued in Spotify; check Spotify before retrying.",
      expect.any(String),
      undefined,
      undefined,
      undefined,
      { automated: true },
    );
  });

  it("charges once when the chat handler overlaps a submit alarm and refunds the ledger amount once", async () => {
    let releaseCharge!: () => void;
    let signalChargeStarted!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeStarted = new Promise<void>((resolve) => { signalChargeStarted = resolve; });
    const harness = await createHarness({ paymentMode: "bot_points", botPointsCost: 13, mode: "automatic" }, {
      beforeChargeCommit: async () => {
        signalChargeStarted();
        await chargeGate;
      },
    });
    const command = processSongRequestsEvent(harness.createEvent("single_charge_viewer"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id, state FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string }>();
    if (row === null) throw new Error("The charging request was not recorded.");

    const alarm = handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.apply.mock.calls.filter((call) => call[1] === "stake")).toHaveLength(1);
    releaseCharge();
    await Promise.all([command, alarm]);
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "approved" });

    await harness.database.prepare("UPDATE song_requests SET charged_amount = 99 WHERE id = ?").bind(row.id).run();
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: row.id, fromState: "approved", toState: "rejected", refundDue: true, now: NOW,
    });
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points }, row.id);

    expect(harness.apply.mock.calls.filter((call) => call[1] === "stake")).toHaveLength(1);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
    expect(harness.apply.mock.calls.find((call) => call[1] === "refund" && call[2].length > 0)?.[2]).toEqual([
      { accountId: "user-single_charge_viewer", login: "single_charge_viewer", delta: 13 },
      { accountId: "__house", delta: -13 },
    ]);
    expect(harness.balanceOf("user-single_charge_viewer")).toBe(1_000);
  });

  it("keeps charging rows out of queues and submit alarms while counting them toward admission caps", async () => {
    let releaseCharge!: () => void;
    let signalChargeStarted!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeStarted = new Promise<void>((resolve) => { signalChargeStarted = resolve; });
    const harness = await createHarness({
      paymentMode: "bot_points",
      mode: "moderated",
      rules: { duplicateEnabled: false, channelOpenLimit: 1 },
    }, {
      beforeChargeCommit: async () => {
        signalChargeStarted();
        await chargeGate;
      },
    });
    const command = processSongRequestsEvent(harness.createEvent("charging_invisible_viewer"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id, state FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string }>();
    if (row === null) throw new Error("The charging request was not recorded.");
    expect(row.state).toBe("charging");
    expect((await pendingSongRequestQueue(harness.database as unknown as D1Database, CHANNEL_ID)).requests).toHaveLength(0);
    expect(await recentSongRequests(harness.database as unknown as D1Database, CHANNEL_ID, "stream-payment-fixture")).toHaveLength(0);
    expect(await readSongRequestQueueState(harness.database as unknown as D1Database, CHANNEL_ID)).toMatchObject({ rows: [] });
    await handleSubmitAlarm(harness.alarmContext, `submit:${row.id}`);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "stake")).toHaveLength(1);
    expect(harness.alarmContext.sendChat).not.toHaveBeenCalled();
    expect(harness.alarmContext.publishModuleOverlayMessage).not.toHaveBeenCalled();

    const second = await processSongRequestsEvent(harness.createEvent("charging_cap_viewer"), harness.context);
    expect(second.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(second.actions[0])).toContain("list is full");
    expect(harness.apply.mock.calls.filter((call) => call[1] === "stake")).toHaveLength(1);
    expect(await harness.database.prepare("SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ count: 1 });
    releaseCharge();
    await command;
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "pending_review" });
  });

  it("lets stale reconciliation claim the charge id before a delayed charge can commit", async () => {
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
    const command = processSongRequestsEvent(harness.createEvent("reconcile_wins_viewer"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The charging request was not recorded.");
    await harness.database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(row.id).run();

    expect(await reconcileStaleSongRequestCharges(harness.alarmContext)).toBe(1);
    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "failed", refund_due: 0 });
    expect(harness.operations.get(songRequestChargeOperationId(row.id))).toMatchObject({
      kind: "refund",
      result: { requestId: row.id, cancelled: true },
      movements: "[]",
    });

    releaseCharge();
    const result = await command;
    expect(JSON.stringify(result.actions[0])).toContain("request is not available right now");
    expect(harness.balanceOf("user-reconcile_wins_viewer")).toBe(1_000);
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(false);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(0);
  });

  it("ages a charging row from D1 insertion time when the event timestamp is old", async () => {
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
    const command = processSongRequestsEvent(harness.createEvent("old_event_viewer", ["viewer"], "2000-01-01T00:00:00.000Z"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id, state, charging_since FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string; charging_since: string }>();
    if (row === null) throw new Error("The charging request was not recorded.");
    expect(row.state).toBe("charging");
    expect(Date.parse(row.charging_since)).toBeGreaterThan(Date.parse("2000-01-01T00:01:00.000Z"));
    expect(await reconcileStaleSongRequestCharges(harness.alarmContext, Date.now())).toBe(0);
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "charging" });

    releaseCharge();
    await command;
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "pending_review" });
  });

  it("reconciles stale charging rows with or without a ledger charge", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" });
    const insertCharging = async (requestId: string): Promise<void> => {
      await transitionRequest(harness.database as unknown as D1Database, {
        channelId: CHANNEL_ID,
        requestId,
        fromState: null,
        toState: "charging",
        now: NOW,
        newRequest: {
          source: "points",
          requestType: "bot_points",
          track: { id: requestId, uri: `spotify:track:${requestId}`, title: requestId, artists: [], durationMs: 1, explicit: false, coverUrl: null, spotifyUrl: `https://open.spotify.com/track/${requestId}` },
          operationId: `sr:${requestId}`,
          streamId: "stream-payment-fixture",
          roundId: "stream-payment-fixture",
          chargedAmount: 17,
          requesterUserId: `user-${requestId}`,
          requesterLogin: requestId,
          requesterDisplayName: requestId,
        },
      });
    };
    await insertCharging("stale_charged_request");
    await insertCharging("stale_uncharged_request");
    await harness.database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    await harness.points.apply(songRequestChargeOperationId("stale_charged_request"), "stake", [
      { accountId: "user-stale_charged_request", login: "stale_charged_request", delta: -17 },
      { accountId: "__house", delta: 17 },
    ], { requestId: "stale_charged_request", trackId: "stale_charged_request", amount: 17 }, { requestId: "stale_charged_request" });

    await harness.database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).run();
    await pollSongRequestsPlayback(harness.alarmContext);

    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = 'stale_charged_request'").first())
      .toEqual({ state: "failed", refund_due: 0 });
    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = 'stale_uncharged_request'").first())
      .toEqual({ state: "failed", refund_due: 0 });
    expect(harness.operations.get(songRequestChargeOperationId("stale_uncharged_request"))).toMatchObject({
      kind: "refund",
      result: { requestId: "stale_uncharged_request", cancelled: true },
      movements: "[]",
    });
    expect(harness.apply.mock.calls.some((call) =>
      call[0] === songRequestChargeOperationId("stale_charged_request") && call[1] === "refund" && call[2].length === 0,
    )).toBe(true);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
    expect(harness.apply.mock.calls.find((call) => call[1] === "refund" && call[2].length > 0)?.[2]).toEqual([
      { accountId: "user-stale_charged_request", login: "stale_charged_request", delta: 17 },
      { accountId: "__house", delta: -17 },
    ]);
  });

  it("does not refund a charged request when stale reconciliation loses its charging-state compare-and-set", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" });
    const requestId = "reconcile_loses_compare_and_set";
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID,
      requestId,
      fromState: null,
      toState: "charging",
      now: NOW,
      newRequest: {
        source: "points",
        requestType: "bot_points",
        track: { id: requestId, uri: `spotify:track:${requestId}`, title: requestId, artists: [], durationMs: 1, explicit: false, coverUrl: null, spotifyUrl: `https://open.spotify.com/track/${requestId}` },
        operationId: `sr:${requestId}`,
        streamId: "stream-payment-fixture",
        roundId: "stream-payment-fixture",
        chargedAmount: 17,
        requesterUserId: `user-${requestId}`,
        requesterLogin: requestId,
        requesterDisplayName: requestId,
      },
    });
    await harness.database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(requestId).run();
    const chargeId = songRequestChargeOperationId(requestId);
    await harness.points.apply(chargeId, "stake", [
      { accountId: `user-${requestId}`, login: requestId, delta: -17 },
      { accountId: "__house", delta: 17 },
    ], { requestId, trackId: requestId, amount: 17 }, { requestId });

    const readOperation = (operationId: string) => Promise.resolve(harness.operations.get(operationId) ?? null);
    let advanced = false;
    vi.spyOn(harness.points, "getOperation").mockImplementation(async (operationId) => {
      if (!advanced && operationId === chargeId) {
        advanced = true;
        expect(await transitionRequest(harness.database as unknown as D1Database, {
          channelId: CHANNEL_ID, requestId, fromState: "charging", toState: "approved", chargedAmount: 17, chargedAt: NOW, now: NOW,
        })).toBe(true);
        expect(await transitionRequest(harness.database as unknown as D1Database, {
          channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now: NOW,
        })).toBe(true);
        expect(await transitionRequest(harness.database as unknown as D1Database, {
          channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now: NOW,
        })).toBe(true);
        expect(await transitionRequest(harness.database as unknown as D1Database, {
          channelId: CHANNEL_ID, requestId, fromState: "submitted", toState: "observed_playing", now: NOW,
        })).toBe(true);
      }
      return await readOperation(operationId);
    });

    expect(await reconcileStaleSongRequestCharges(harness.alarmContext)).toBe(0);
    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "observed_playing", refund_due: 0 });
    expect(harness.balanceOf(`user-${requestId}`)).toBe(983);
    expect(harness.operations.has(songRequestRefundOperationId(requestId))).toBe(false);
  });

  it("reconciles stale charging rows before the Clear list cleanup", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" });
    const requestId = "clear_stale_charge";
    await transitionRequest(harness.database as unknown as D1Database, {
      channelId: CHANNEL_ID,
      requestId,
      fromState: null,
      toState: "charging",
      now: NOW,
      newRequest: {
        source: "points",
        requestType: "bot_points",
        track: { id: requestId, uri: `spotify:track:${requestId}`, title: requestId, artists: [], durationMs: 1, explicit: false, coverUrl: null, spotifyUrl: `https://open.spotify.com/track/${requestId}` },
        operationId: `sr:${requestId}`,
        streamId: "stream-payment-fixture",
        roundId: "stream-payment-fixture",
        chargedAmount: 17,
        requesterUserId: `user-${requestId}`,
        requesterLogin: requestId,
        requesterDisplayName: requestId,
      },
    });
    await harness.database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(requestId).run();
    await harness.points.apply(songRequestChargeOperationId(requestId), "stake", [
      { accountId: `user-${requestId}`, login: requestId, delta: -17 },
      { accountId: "__house", delta: 17 },
    ], { requestId, trackId: requestId, amount: 17 }, { requestId });

    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/clear`, {
      method: "POST",
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: true });
    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?").bind(requestId).first())
      .toEqual({ state: "failed", refund_due: 0 });
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
    expect(harness.apply.mock.calls.find((call) => call[1] === "refund" && call[2].length > 0)?.[2]).toEqual([
      { accountId: `user-${requestId}`, login: requestId, delta: 17 },
      { accountId: "__house", delta: -17 },
    ]);
  });

  it("does not leave a refund flag or reschedule a disabled module after a failed charge races cleanup", async () => {
    let releaseCharge!: () => void;
    let signalChargeStarted!: () => void;
    const chargeGate = new Promise<void>((resolve) => { releaseCharge = resolve; });
    const chargeStarted = new Promise<void>((resolve) => { signalChargeStarted = resolve; });
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" }, {
      failCharge: true,
      beforeChargeCommit: async () => {
        signalChargeStarted();
        await chargeGate;
      },
    });
    const command = processSongRequestsEvent(harness.createEvent("failed_cleanup_race"), harness.context);
    await chargeStarted;
    const row = await harness.database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string }>();
    if (row === null) throw new Error("The charging request was not recorded.");
    await harness.database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(row.id).run();
    await reconcileStaleSongRequestCharges(harness.alarmContext);
    await cleanupSongRequestRound(harness.database as unknown as D1Database, CHANNEL_ID, "stream-payment-fixture", NOW, "module_disabled");
    await retrySongRequestRefunds({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points });
    releaseCharge();
    await command;

    await harness.database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).run();
    await pollSongRequestsPlayback(harness.alarmContext);

    expect(await harness.database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ state: "failed", refund_due: 0 });
    expect(harness.alarmContext.schedule).not.toHaveBeenCalled();
    expect(harness.alarmContext.clear).toHaveBeenCalledWith("poll");
  });

  it("keeps a charging request out of moderation until the charge completes", async () => {
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

    const earlyResponse = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/reject`, {
      method: "POST",
    }), { DB: harness.database as unknown as D1Database });
    expect(earlyResponse.status).toBe(409);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund")).toHaveLength(0);
    releaseCharge();
    const result = await command;

    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(result.actions[0])).toContain("waiting");
    const response = await removeAppFor(harness.points).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/requests/${row.id}/reject`, {
      method: "POST",
    }), { DB: harness.database as unknown as D1Database });
    expect(response.status).toBe(200);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(1);
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
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(2);
    expect(await harness.database.prepare("SELECT refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ refund_due: 1 });

    await retrySongRequestRefunds({ DB: harness.database as unknown as D1Database, channelId: CHANNEL_ID, points: harness.points });
    expect(await harness.database.prepare("SELECT refund_due FROM song_requests WHERE id = ?").bind(row.id).first())
      .toEqual({ refund_due: 0 });
    expect(harness.operations.has(songRequestRefundOperationId(row.id))).toBe(true);
    expect(harness.apply.mock.calls.filter((call) => call[1] === "refund" && call[2].length > 0)).toHaveLength(3);
  });

  it("rejects a charged pre-submission request and refunds it", async () => {
    const harness = await createHarness({ paymentMode: "bot_points", mode: "moderated" });
    await processSongRequestsEvent(harness.createEvent("pre_submit_viewer"), harness.context);
    const row = await harness.database.prepare("SELECT id, state FROM song_requests WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ id: string; state: string }>();
    if (row === null) throw new Error("The moderated request was not recorded.");
    await harness.database.prepare("UPDATE song_requests SET charged_amount = 0 WHERE id = ?").bind(row.id).run();
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
    expect(withRefund.apply).toHaveBeenCalledTimes(3);
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
