import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext, ModuleExecutionContext } from "../../src/modules/contract";
import { readSongRequest, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { requestSongChannelPointsAction } from "../../src/modules/song_requests/channel-points-action";
import {
  handleSongRequestsActivation,
  handleSongRequestsLifecycleAlarm,
  handleSubmitAlarm,
  SONG_REQUESTS_LIFECYCLE_HANDLER,
} from "../../src/modules/song_requests/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "song-request-channel-points-action";
const NOW = "2026-11-16T19:00:00.000Z";
const spotifyTrack = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "fictional-cover", width: 640, height: 640 }] },
  external_urls: { spotify: "fictional-track" },
};
const trackWithId = (id: string) => ({
  ...spotifyTrack,
  id,
  uri: `spotify:track:${id}`,
  name: id,
  external_urls: { spotify: `fictional-track-${id}` },
});

const createFixture = async () => {
  const database = new TestD1Database();
  await insertChannel(database, CHANNEL_ID);
  const settings = JSON.stringify({ mode: "moderated", paymentMode: "free" });
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, ?)",
  ).bind(CHANNEL_ID, settings).run();
  await database.prepare(
    "INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', 'stream-channel-points-action')",
  ).bind(CHANNEL_ID, NOW).run();
  await database.prepare(
    "INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, 'manager-fixture', ?)",
  ).bind(CHANNEL_ID, NOW).run();
  await database.prepare(
    `INSERT INTO channel_points_rewards
      (channel_id, id, twitch_reward_id, title, prompt, cost, background_color, is_user_input_required,
       global_cooldown_seconds, max_per_stream, max_per_user_per_stream, action_module_id, action_id,
       action_config_json, mode, enabled, twitch_state, created_at, updated_at)
     VALUES (?, 'reward-local', 'reward-twitch', 'Request a song', NULL, 500, NULL, 1,
       30, NULL, 2, 'song_requests', 'request-song', '{}', 'auto', 1, 'active', ?, ?)`
  ).bind(CHANNEL_ID, NOW, NOW).run();
  const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify(spotifyTrack), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
  vi.stubGlobal("fetch", fetcher);
  const scheduleAlarm = vi.fn(() => Promise.resolve());
  const publishModuleOverlayMessage = vi.fn<ModuleAlarmContext["publishModuleOverlayMessage"]>(() => Promise.resolve());
  const lifecycleContext = {
    DB: database,
    channelId: CHANNEL_ID,
    schedule: vi.fn<ModuleAlarmContext["schedule"]>(() => Promise.resolve()),
    clear: vi.fn<ModuleAlarmContext["clear"]>(() => Promise.resolve()),
    publishModuleOverlayMessage,
  } as unknown as ModuleAlarmContext;
  const runModuleAlarm = vi.fn<NonNullable<ModuleExecutionContext["runModuleAlarm"]>>(async (handlerKey, alarmKey, invocation) => {
    if (handlerKey === "access_token") return "spotify-access-fixture";
    if (handlerKey === SONG_REQUESTS_LIFECYCLE_HANDLER) {
      await handleSongRequestsLifecycleAlarm(lifecycleContext, alarmKey, Date.parse(NOW), undefined, invocation);
      return undefined;
    }
    return undefined;
  });
  const pointStake = vi.fn(() => Promise.resolve({ ok: true }));
  const pointGetOperation = vi.fn(() => Promise.resolve(null));
  const context = {
    DB: database,
    channelId: CHANNEL_ID,
    environment: { APP_ENV: "production" },
    runModuleAlarm,
    scheduleAlarm,
    points: { stake: pointStake, getOperation: pointGetOperation },
  } as unknown as ModuleExecutionContext;
  return { database, context, fetcher, scheduleAlarm, pointStake, pointGetOperation, publishModuleOverlayMessage };
};

const redemption = {
  id: "redemption-channel-points-1",
  rewardId: "reward-twitch",
  rewardTitle: "Request a song",
  userId: "viewer-fictional",
  userLogin: "harbor_viewer",
  userName: "Harbor Viewer",
  userInput: "spotify:track:glassharbor01",
  redeemedAt: NOW,
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("song request channel-points action", () => {
  it("admits one ledger row and reports it on repeated calls without another Spotify lookup", async () => {
    const { database, context, fetcher, scheduleAlarm, pointStake, pointGetOperation } = await createFixture();
    const input = { redemption, operationId: redemption.id, config: {} };

    await expect(requestSongChannelPointsAction.execute(context, input)).resolves.toBe("pending");
    await expect(requestSongChannelPointsAction.execute(context, input)).resolves.toBe("pending");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scheduleAlarm).not.toHaveBeenCalled();
    expect(pointStake).not.toHaveBeenCalled();
    expect(pointGetOperation).not.toHaveBeenCalled();
    expect(await database.prepare(
      "SELECT id, operation_id, source, request_type, charged_amount, channel_points_reward_id, state FROM song_requests",
    ).first()).toEqual({
      id: redemption.id,
      operation_id: redemption.id,
      source: "channel_points",
      request_type: "channel_points",
      charged_amount: 0,
      channel_points_reward_id: redemption.rewardId,
      state: "pending_review",
    });
  });

  it("emits one queue_changed overlay message after a successful channel-points admission", async () => {
    const { context, publishModuleOverlayMessage } = await createFixture();

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");
    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");

    expect(publishModuleOverlayMessage).toHaveBeenCalledOnce();
    expect(publishModuleOverlayMessage).toHaveBeenCalledWith(
      "queue_changed",
      "song_requests.queue",
      expect.any(Object),
    );
  });

  it("applies the reward per-user limit in addition to song-request rules", async () => {
    const { database, context, fetcher } = await createFixture();
    const settings = JSON.stringify({
      mode: "moderated", paymentMode: "free",
      rules: {
        duplicateEnabled: false, songCooldownEnabled: false, personCooldownEnabled: false,
        personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimitEnabled: false,
        artistOpenLimitEnabled: false, maxTrackLengthEnabled: false, explicitAllowed: true,
      },
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(settings, CHANNEL_ID).run();
    await database.prepare("UPDATE channel_points_rewards SET global_cooldown_seconds = NULL, max_per_user_per_stream = 1 WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("glassharbor01")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("quietatlas02")), { status: 200 }));

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");
    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: { ...redemption, id: "redemption-channel-points-limit-2", userInput: "spotify:track:quietatlas02" },
      operationId: "redemption-channel-points-limit-2", config: {},
    })).resolves.toHaveProperty("refund");

    await expect(database.prepare("SELECT count(*) AS count FROM song_requests").first()).resolves.toEqual({ count: 1 });
  });

  it("skips current reward limits for provider-latched rows without a limits snapshot", async () => {
    const { database, context, fetcher } = await createFixture();
    const settings = JSON.stringify({
      mode: "moderated", paymentMode: "free",
      rules: {
        duplicateEnabled: false, songCooldownEnabled: false, personCooldownEnabled: false,
        personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimitEnabled: false,
        artistOpenLimitEnabled: false, maxTrackLengthEnabled: false, explicitAllowed: true,
      },
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(settings, CHANNEL_ID).run();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("glassharbor01")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("quietatlas02")), { status: 200 }));
    const firstRedemption = { ...redemption, providerIsLatched: true };

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: firstRedemption, operationId: firstRedemption.id, config: {},
    })).resolves.toBe("pending");
    await database.prepare("UPDATE channel_points_rewards SET max_per_user_per_stream = 1 WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const retriedRedemption = {
      ...redemption,
      id: "redemption-channel-points-latched-without-limits",
      userInput: "spotify:track:quietatlas02",
      providerIsLatched: true,
    };

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: retriedRedemption, operationId: retriedRedemption.id, config: {},
    })).resolves.toBe("pending");
    await expect(database.prepare("SELECT count(*) AS count FROM song_requests").first()).resolves.toEqual({ count: 2 });
  });

  it("uses current reward limits for legacy rows with NULL provider IDs", async () => {
    const { database, context, fetcher } = await createFixture();
    const settings = JSON.stringify({
      mode: "moderated", paymentMode: "free",
      rules: {
        duplicateEnabled: false, songCooldownEnabled: false, personCooldownEnabled: false,
        personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimitEnabled: false,
        artistOpenLimitEnabled: false, maxTrackLengthEnabled: false, explicitAllowed: true,
      },
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(settings, CHANNEL_ID).run();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("glassharbor01")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("quietatlas02")), { status: 200 }));

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");
    await database.prepare("UPDATE channel_points_rewards SET max_per_user_per_stream = 1 WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const legacyRedemption = {
      ...redemption,
      id: "redemption-channel-points-legacy-current-limit",
      userInput: "spotify:track:quietatlas02",
      providerIsLatched: false,
    };

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: legacyRedemption, operationId: legacyRedemption.id, config: {},
    })).resolves.toHaveProperty("refund");
    await expect(database.prepare("SELECT count(*) AS count FROM song_requests").first()).resolves.toEqual({ count: 1 });
  });

  it("applies the reward global cooldown alongside song-request rules", async () => {
    const { database, context, fetcher } = await createFixture();
    const settings = JSON.stringify({
      mode: "moderated", paymentMode: "free",
      rules: {
        duplicateEnabled: false, songCooldownEnabled: false, personCooldownEnabled: false,
        personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimitEnabled: false,
        artistOpenLimitEnabled: false, maxTrackLengthEnabled: false, explicitAllowed: true,
      },
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(settings, CHANNEL_ID).run();
    await database.prepare("UPDATE channel_points_rewards SET global_cooldown_seconds = 30, max_per_user_per_stream = NULL WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("glassharbor01")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("quietatlas02")), { status: 200 }));

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");
    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: {
        ...redemption, id: "redemption-channel-points-cooldown", userId: "viewer-other", userLogin: "quiet_viewer",
        userInput: "spotify:track:quietatlas02",
      },
      operationId: "redemption-channel-points-cooldown", config: {},
    })).resolves.toHaveProperty("refund");

    await expect(database.prepare("SELECT count(*) AS count FROM song_requests").first()).resolves.toEqual({ count: 1 });
  });

  it("uses the redemption's latched reward limits after reward settings change", async () => {
    const { database, context, fetcher } = await createFixture();
    const settings = JSON.stringify({
      mode: "moderated", paymentMode: "free",
      rules: {
        duplicateEnabled: false, songCooldownEnabled: false, personCooldownEnabled: false,
        personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimitEnabled: false,
        artistOpenLimitEnabled: false, maxTrackLengthEnabled: false, explicitAllowed: true,
      },
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(settings, CHANNEL_ID).run();
    await database.prepare(
      "UPDATE channel_points_rewards SET global_cooldown_seconds = NULL, max_per_user_per_stream = NULL WHERE channel_id = ?",
    ).bind(CHANNEL_ID).run();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("glassharbor01")), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(trackWithId("quietatlas02")), { status: 200 }));

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    })).resolves.toBe("pending");
    await database.prepare("UPDATE channel_points_rewards SET max_per_user_per_stream = 1 WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const redemptionWithLatchedLimits = {
      ...redemption,
      id: "redemption-channel-points-latched-limits",
      userInput: "spotify:track:quietatlas02",
      rewardLimits: { maxPerUserPerStream: null, globalCooldownSeconds: null },
    };

    await expect(requestSongChannelPointsAction.execute(context, {
      redemption: redemptionWithLatchedLimits, operationId: redemptionWithLatchedLimits.id, config: {},
    })).resolves.toBe("pending");
    await expect(database.prepare("SELECT count(*) AS count FROM song_requests").first()).resolves.toEqual({ count: 2 });
  });

  it("closes the ledger on an external Twitch cancellation without creating another refund obligation", async () => {
    const { database, context, publishModuleOverlayMessage } = await createFixture();
    await requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    });

    await requestSongChannelPointsAction.onRedemptionResolved?.(context, redemption.id, "CANCELED");

    await expect(readSongRequest(database as unknown as D1Database, CHANNEL_ID, redemption.id))
      .resolves.toMatchObject({ state: "rejected", failureReason: "twitch_canceled" });
    await expect(database.prepare(
      "SELECT channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind(redemption.id).first()).resolves.toEqual({ channel_points_resolution_due: null });
    expect(publishModuleOverlayMessage).toHaveBeenCalledTimes(2);
    expect(publishModuleOverlayMessage).toHaveBeenLastCalledWith(
      "queue_changed", "song_requests.queue", expect.any(Object),
    );
  });

  it("closes an externally fulfilled request without sending a cancellation", async () => {
    const { database, context, publishModuleOverlayMessage } = await createFixture();
    await requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    });

    await requestSongChannelPointsAction.onRedemptionResolved?.(context, redemption.id, "FULFILLED");

    await expect(readSongRequest(database as unknown as D1Database, CHANNEL_ID, redemption.id))
      .resolves.toMatchObject({ state: "removed", failureReason: "twitch_fulfilled_externally" });
    await expect(database.prepare(
      "SELECT channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind(redemption.id).first()).resolves.toEqual({ channel_points_resolution_due: null });
    expect(publishModuleOverlayMessage).toHaveBeenCalledTimes(2);
    expect(publishModuleOverlayMessage).toHaveBeenLastCalledWith(
      "queue_changed", "song_requests.queue", expect.any(Object),
    );
  });

  it("does not enqueue a song when Twitch canceled its redemption before Spotify submission", async () => {
    const { database, context, fetcher } = await createFixture();
    await requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    });
    await transitionRequest(database as unknown as D1Database, {
      channelId: CHANNEL_ID, requestId: redemption.id, fromState: "pending_review", toState: "approved", now: NOW,
    });
    fetcher.mockClear();
    const readRedemptionStatus = vi.fn(async (operationId: string) => {
      await requestSongChannelPointsAction.onRedemptionResolved?.(context, operationId, "CANCELED");
      return "CANCELED" as const;
    });
    const alarmContext = {
      ...context,
      streamState: () => Promise.resolve("online" as const),
      streamStartedAt: () => Promise.resolve({ streamId: "stream-channel-points-action", startedAt: NOW }),
      channelPoints: { resolveRedemption: vi.fn(() => Promise.resolve(true)), readRedemptionStatus },
      schedule: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve()),
      channelLanguage: () => Promise.resolve("en" as const),
      sendChat: vi.fn(() => Promise.resolve({ retryable: false })),
      publishModuleOverlayMessage: vi.fn(() => Promise.resolve()),
    } as unknown as ModuleAlarmContext;

    await handleSubmitAlarm(alarmContext, `submit:${redemption.id}`);

    expect(readRedemptionStatus).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(readSongRequest(database as unknown as D1Database, CHANNEL_ID, redemption.id))
      .resolves.toMatchObject({ state: "rejected", failureReason: "twitch_canceled" });
  });

  it("pushes a durable Twitch cancellation when song requests are disabled", async () => {
    const { database, context } = await createFixture();
    await requestSongChannelPointsAction.execute(context, {
      redemption, operationId: redemption.id, config: {},
    });
    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(CHANNEL_ID).run();
    const resolveRedemption = vi.fn((operationId: string, status: string) => Promise.resolve(operationId.length > 0 && status.length > 0));
    const schedule = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const publishModuleOverlayMessage = vi.fn(() => Promise.resolve());
    const alarmContext = {
      DB: database,
      channelId: CHANNEL_ID,
      channelPoints: { resolveRedemption, readRedemptionStatus: vi.fn(() => Promise.resolve("UNFULFILLED" as const)) },
      points: { getOperation: vi.fn(() => Promise.resolve(null)) },
      schedule,
      clear,
      publishModuleOverlayMessage,
    } as unknown as ModuleAlarmContext;

    await handleSongRequestsActivation(alarmContext, false);

    expect(resolveRedemption).toHaveBeenCalledWith(redemption.id, "CANCELED");
    await expect(readSongRequest(database as unknown as D1Database, CHANNEL_ID, redemption.id))
      .resolves.toMatchObject({ state: "rejected", channelPointsRewardId: redemption.rewardId });
    await expect(database.prepare(
      "SELECT channel_points_resolution_due FROM song_requests WHERE id = ?",
    ).bind(redemption.id).first()).resolves.toEqual({ channel_points_resolution_due: null });
  });
});
