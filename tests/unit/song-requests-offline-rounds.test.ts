import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleChatVoteStartRequest, ModuleEvent, ModuleExecutionContext, ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsSettingsSchema, type SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import { processSongRequestsEvent, refundRequestId, handleSongRequestsActivation, handleSongRequestsSettingsChanged, songRequestChargeOperationId, songRequestRefundOperationId } from "../../src/modules/song_requests/service";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-11-15T20:00:00.000Z";
const databases: TestD1Database[] = [];

const createHarness = async (channelId: string) => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, channelId);
  const settings = songRequestsSettingsSchema.parse({ alsoOffline: true });
  const roundId = `offline-round-${channelId}`;
  await database.batch([
    database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'song_requests', 1, ?, 1)")
      .bind(channelId, JSON.stringify(settings)),
    database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, 'operator', ?)")
      .bind(channelId, NOW),
    database.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'offline', ?, 'eventsub', NULL)")
      .bind(channelId, NOW),
    database.prepare("INSERT INTO song_requests_offline_rounds (channel_id, round_id, created_at) VALUES (?, ?, ?)")
      .bind(channelId, roundId, NOW),
  ]);
  const operations = new Map<string, { kind: string; result: unknown }>();
  const apply = vi.fn((operationId: string, kind: string, _movements: unknown[], result: unknown) => {
    if (operations.has(operationId)) return Promise.resolve({ result: operations.get(operationId)?.result });
    operations.set(operationId, { kind, result });
    return Promise.resolve({ result });
  });
  const points = {
    apply,
    getOperation: vi.fn((operationId: string) => Promise.resolve(operations.get(operationId) ?? null)),
  } as unknown as ModulePointsAccess;
  const addRequest = async (requestId: string, state: "pending_review" | "submitting" | "submitted" | "outcome_unknown"): Promise<void> => {
    const trackId = requestId.replace(/[^A-Za-z0-9]/gu, "").slice(-20);
    const newRequest = {
      source: "points" as const,
      requestType: "bot_points" as const,
      track: {
        id: trackId,
        uri: `spotify:track:${trackId}`,
        title: `Track ${requestId}`,
        artists: ["Mira Vale"],
        durationMs: 201_000,
        explicit: false,
        coverUrl: null,
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      },
      operationId: `sr:${requestId}`,
      streamId: null,
      roundId,
      chargedAmount: 11,
      requesterUserId: "viewer-offline",
      requesterLogin: "viewer_offline",
      requesterDisplayName: "Viewer Offline",
    };
    const initialState = state === "pending_review" ? "pending_review" : "approved";
    await transitionRequest(database as unknown as D1Database, {
      channelId, requestId, fromState: null, toState: initialState, now: NOW, newRequest,
    });
    if (state !== "pending_review") {
      await transitionRequest(database as unknown as D1Database, { channelId, requestId, fromState: "approved", toState: "submitting", now: NOW });
      if (state !== "submitting") {
        await transitionRequest(database as unknown as D1Database, {
          channelId, requestId, fromState: "submitting", toState: state, now: NOW,
        });
      }
    }
    operations.set(songRequestChargeOperationId(requestId), { kind: "stake", result: { requestId } });
  };
  const alarmContext = {
    DB: database as unknown as D1Database,
    channelId,
    points,
    clear: vi.fn<ModuleAlarmContext["clear"]>(() => Promise.resolve()),
    schedule: vi.fn<ModuleAlarmContext["schedule"]>(() => Promise.resolve()),
    publishModuleOverlayMessage: vi.fn<ModuleAlarmContext["publishModuleOverlayMessage"]>(() => Promise.resolve()),
    streamGeneration: null,
  } as unknown as ModuleAlarmContext;
  return { database, channelId, roundId, settings, points, apply, operations, addRequest, alarmContext };
};

const expectRefundedOnce = async (harness: Awaited<ReturnType<typeof createHarness>>, requestIds: string[]): Promise<void> => {
  for (const requestId of requestIds) {
    expect(harness.operations.has(songRequestRefundOperationId(requestId))).toBe(true);
    await refundRequestId({ DB: harness.database as unknown as D1Database, channelId: harness.channelId, points: harness.points }, requestId);
  }
  expect(harness.apply).toHaveBeenCalledTimes(requestIds.length);
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("song request offline rounds", () => {
  it("ends the offline round on stream.online, refunding unsent and unclear requests only", async () => {
    const harness = await createHarness("song-requests-offline-online");
    await harness.addRequest("offline-pending-online", "pending_review");
    await harness.addRequest("offline-unknown-online", "outcome_unknown");
    await harness.addRequest("offline-submitted-online", "submitted");
    await harness.database.prepare("UPDATE channel_stream_state SET state = 'online', stream_id = 'stream-after-offline' WHERE channel_id = ?")
      .bind(harness.channelId).run();
    const event: ModuleEvent<SongRequestsSettings> = {
      channelId: harness.channelId,
      subscriptionType: "stream.online",
      triggerId: "offline-round-ended-by-stream-start",
      payload: {},
      settings: harness.settings,
      receivedAt: "2026-11-15T20:01:00.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      DB: harness.database as unknown as D1Database,
      channelId: harness.channelId,
      points: harness.points,
      streamStateTransitionAccepted: true,
      scheduleAlarm: vi.fn(() => Promise.resolve()),
      clearAlarm: vi.fn(() => Promise.resolve()),
    } as unknown as ModuleExecutionContext;

    await processSongRequestsEvent(event, context);

    expect(await harness.database.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(harness.channelId).first()).toBeNull();
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-pending-online'").first())
      .toEqual({ state: "rejected" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-unknown-online'").first())
      .toEqual({ state: "failed" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-submitted-online'").first())
      .toEqual({ state: "not_observed" });
    await expectRefundedOnce(harness, ["offline-pending-online", "offline-unknown-online"]);
    expect(harness.operations.has(songRequestRefundOperationId("offline-submitted-online"))).toBe(false);
  });

  it("refunds unsent and unclear paid requests at stream.offline", async () => {
    const harness = await createHarness("song-requests-stream-offline-refunds");
    await harness.addRequest("offline-pending-stream-end", "pending_review");
    await harness.addRequest("offline-submitting-stream-end", "submitting");
    await harness.addRequest("offline-unknown-stream-end", "outcome_unknown");
    await harness.addRequest("offline-submitted-stream-end", "submitted");
    await harness.database.prepare("UPDATE channel_stream_state SET state = 'online', stream_id = ? WHERE channel_id = ?")
      .bind(harness.roundId, harness.channelId).run();
    await harness.database.prepare("UPDATE song_requests SET stream_id = ? WHERE channel_id = ?")
      .bind(harness.roundId, harness.channelId).run();
    await harness.database.prepare("DELETE FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(harness.channelId).run();
    await harness.database.prepare("UPDATE channel_stream_state SET state = 'offline', stream_id = NULL WHERE channel_id = ?")
      .bind(harness.channelId).run();
    const event: ModuleEvent<SongRequestsSettings> = {
      channelId: harness.channelId,
      subscriptionType: "stream.offline",
      triggerId: "live-round-ended",
      payload: {},
      settings: songRequestsSettingsSchema.parse({ ...harness.settings, alsoOffline: false }),
      receivedAt: "2026-11-15T20:01:00.000Z",
      actor: null,
      chatStatus: null,
    };
    const context = {
      DB: harness.database as unknown as D1Database,
      channelId: harness.channelId,
      points: harness.points,
      streamStateTransitionAccepted: true,
      streamSession: { streamId: harness.roundId, startedAt: NOW },
      scheduleAlarm: vi.fn(() => Promise.resolve()),
      clearAlarm: vi.fn(() => Promise.resolve()),
    } as unknown as ModuleExecutionContext;

    await processSongRequestsEvent(event, context);

    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-pending-stream-end'").first())
      .toEqual({ state: "rejected" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-unknown-stream-end'").first())
      .toEqual({ state: "failed" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-submitting-stream-end'").first())
      .toEqual({ state: "failed" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-submitted-stream-end'").first())
      .toEqual({ state: "not_observed" });
    await expectRefundedOnce(harness, ["offline-pending-stream-end", "offline-submitting-stream-end", "offline-unknown-stream-end"]);
    expect(harness.operations.has(songRequestRefundOperationId("offline-submitted-stream-end"))).toBe(false);
  });

  it("ends and refunds an offline round when Also offline is switched off", async () => {
    const harness = await createHarness("song-requests-offline-setting-disabled");
    await harness.addRequest("offline-pending-disabled", "pending_review");
    await harness.addRequest("offline-unknown-disabled", "outcome_unknown");
    const settings = songRequestsSettingsSchema.parse({ ...harness.settings, alsoOffline: false });
    await harness.database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify(settings), harness.channelId).run();

    await handleSongRequestsSettingsChanged(harness.alarmContext);

    expect(await harness.database.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(harness.channelId).first()).toBeNull();
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-pending-disabled'").first())
      .toEqual({ state: "rejected" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-unknown-disabled'").first())
      .toEqual({ state: "failed" });
    await expectRefundedOnce(harness, ["offline-pending-disabled", "offline-unknown-disabled"]);
  });

  it("rejects and refunds all charged open requests when the module is disabled", async () => {
    const harness = await createHarness("song-requests-offline-module-disabled");
    await harness.addRequest("offline-pending-module-disabled", "pending_review");
    await harness.addRequest("offline-unknown-module-disabled", "outcome_unknown");
    await harness.addRequest("offline-submitted-module-disabled", "submitted");
    await harness.database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(harness.channelId).run();

    await handleSongRequestsActivation(harness.alarmContext, false);

    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-pending-module-disabled'").first())
      .toEqual({ state: "rejected" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-unknown-module-disabled'").first())
      .toEqual({ state: "failed" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-submitted-module-disabled'").first())
      .toEqual({ state: "removed" });
    await expectRefundedOnce(harness, [
      "offline-pending-module-disabled",
      "offline-unknown-module-disabled",
      "offline-submitted-module-disabled",
    ]);
  });

  it("ends and refunds the offline round through the moderator Clear list route", async () => {
    const harness = await createHarness("song-requests-offline-clear");
    await harness.addRequest("offline-pending-clear", "pending_review");
    await harness.addRequest("offline-unknown-clear", "outcome_unknown");
    const publish = vi.fn(() => Promise.resolve());
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("points", () => harness.points);
      context.set("publishModuleOverlayMessage", publish);
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${harness.channelId}/clear`, { method: "POST" }), {
      DB: harness.database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: true });
    expect(await harness.database.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(harness.channelId).first()).toBeNull();
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-pending-clear'").first())
      .toEqual({ state: "rejected" });
    expect(await harness.database.prepare("SELECT state FROM song_requests WHERE id = 'offline-unknown-clear'").first())
      .toEqual({ state: "failed" });
    expect(publish).toHaveBeenCalled();
    await expectRefundedOnce(harness, ["offline-pending-clear", "offline-unknown-clear"]);
  });

  it("rejects offline voting by default and fences accepted votes to the current offline round", async () => {
    const harness = await createHarness("song-requests-offline-vote");
    await harness.database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
      .bind(harness.channelId, NOW).run();
    const startChatVote = vi.fn<(channelId: string, request: ModuleChatVoteStartRequest) => Promise<{ status: "started"; ballotId: string }>>(
      (_channelId, request) => Promise.resolve({ status: "started", ballotId: request.ballotId ?? "missing-ballot" }),
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const id = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname.split("/").at(-1) ?? "glassharbor01";
      const track = {
        id,
        uri: `spotify:track:${id}`,
        name: id === "glassharbor01" ? "Glass Harbor" : "Quiet Atlas",
        duration_ms: 201_000,
        explicit: false,
        artists: [{ id: "miravale01", name: "Mira Vale" }],
        album: { name: "Quiet Atlas", images: [] },
        external_urls: { spotify: `https://open.spotify.com/track/${id}` },
      };
      return Promise.resolve(new Response(JSON.stringify(track), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("session", { userId: "moderator-offline", sessionId: "offline-vote-session" });
      context.set("startChatVote", startChatVote);
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);
    const environment = {
      DB: harness.database as unknown as D1Database,
      APP_ENV: "local",
      SPOTIFY_API_BASE: "https://spotify.mock/v1",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-offline") }),
      },
    };
    const createVoteRequest = (): Request => new Request(`https://brobot.example/channels/${harness.channelId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackIds: ["glassharbor01", "quietatlas02"] }),
    });

    const disabled = songRequestsSettingsSchema.parse({ ...harness.settings, alsoOffline: false });
    await harness.database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify(disabled), harness.channelId).run();
    const rejected = await app.fetch(createVoteRequest(), environment);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "stream_offline" });
    expect(startChatVote).not.toHaveBeenCalled();

    await harness.database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify(harness.settings), harness.channelId).run();
    const accepted = await app.fetch(createVoteRequest(), environment);
    expect(accepted.status).toBe(201);
    const vote = await harness.database.prepare("SELECT stream_id, round_id, state FROM song_requests_votes WHERE channel_id = ?")
      .bind(harness.channelId).first<{ stream_id: string | null; round_id: string; state: string }>();
    expect(vote).toMatchObject({ stream_id: null, round_id: harness.roundId, state: "open" });
    expect(startChatVote).toHaveBeenCalledOnce();
  });
});
