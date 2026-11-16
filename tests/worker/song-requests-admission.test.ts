import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { admitSongRequest, cleanupSongRequestRound, pendingSongRequestQueue, songRequestAdmissionFailure, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsSettingsSchema, type SongRequestsSettings } from "../../src/modules/song_requests/contracts";
import { readSongRequestQueueState } from "../../src/modules/song_requests/overlay/queue-state";
import { processSongRequestsEvent, reconcileStaleSongRequestCharges, refundRequestId, songRequestChargeOperationId, songRequestRefundOperationId } from "../../src/modules/song_requests/service";
import { modulePoints } from "../../src/worker/module-points";

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const migrationStatements = (source: string): string[] => {
  const segments = source.split(/\r?\n/u).map((line) => line.replace(/^\s*--.*$/u, "")).join("\n").split(";");
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const segment of segments) {
    const statement = segment.trim();
    if (statement.length === 0) continue;
    if (trigger !== null) {
      if (statement.toUpperCase() === "END") {
        statements.push(`${trigger.join(";")};${statement}`);
        trigger = null;
      } else trigger.push(statement);
    } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) trigger = [statement];
    else statements.push(statement);
  }
  return statements;
};

const database = (env as unknown as Env).DB;
const NOW = "2026-11-15T20:00:00.000Z";
const CHANNEL_ID = "song-requests-admission-concurrent";
const STREAM_ID = "stream-admission-fictional";
const settings = songRequestsSettingsSchema.parse({ rules: {
  personCooldownEnabled: false,
  personOpenLimitEnabled: false,
  personRoundLimitEnabled: false,
  artistOpenLimitEnabled: false,
} });
const settingsJson = JSON.stringify(settings);
const ledgerTrack = {
  id: "realledgertrack01",
  uri: "spotify:track:realledgertrack01",
  name: "Ledger Track",
  duration_ms: 190_000,
  explicit: false,
  artists: [{ id: "fictionalartist01", name: "Fictional Artist" }],
  album: { name: "Ledger Test", images: [] },
  external_urls: { spotify: "spotify-link-fixture" },
};

beforeAll(async () => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    for (const statement of migrationStatements(migrationSources[path] ?? "")) await database.prepare(statement).run();
  }
  await database.prepare("INSERT OR IGNORE INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(CHANNEL_ID, CHANNEL_ID, CHANNEL_ID, NOW, NOW).run();
  await database.batch([
    database.prepare("INSERT OR REPLACE INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'song_requests', 1, ?, 1)")
      .bind(CHANNEL_ID, settingsJson),
    database.prepare("INSERT OR REPLACE INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1)")
      .bind(CHANNEL_ID),
    database.prepare("INSERT OR REPLACE INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, 'operator', ?)")
      .bind(CHANNEL_ID, NOW),
    database.prepare("INSERT OR REPLACE INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', ?)")
      .bind(CHANNEL_ID, NOW, STREAM_ID),
  ]);
});

const requestInput = (index: number, customSettings = settings) => ({
  channelId: CHANNEL_ID,
  requestId: `request-concurrent-${String(index)}`,
  operationId: `sr:request-concurrent-${String(index)}`,
  track: {
    id: `trackconcurrent${String(index)}`,
    uri: `spotify:track:trackconcurrent${String(index)}`,
    title: `Fictional Track ${String(index)}`,
    artists: ["Mira Vale"],
    durationMs: 180_000,
    explicit: false,
    coverUrl: null,
    spotifyUrl: `https://open.spotify.com/track/trackconcurrent${String(index)}`,
  },
  requestType: "bot_points" as const,
  streamId: STREAM_ID,
  roundId: STREAM_ID,
  settingsJson: JSON.stringify(customSettings),
  settings: customSettings,
  requesterUserId: `viewer-${String(index)}`,
  requesterLogin: `viewer-${String(index)}`,
  requesterDisplayName: `Viewer ${String(index)}`,
  initialState: "approved" as const,
  now: NOW,
});

describe("song request admission on D1", () => {
  const configure = async (customSettings: ReturnType<typeof songRequestsSettingsSchema.parse>): Promise<void> => {
    await database.prepare("DELETE FROM song_requests WHERE channel_id = ?").bind(CHANNEL_ID).run();
    await database.prepare("UPDATE channel_stream_state SET state = 'online', stream_id = ? WHERE channel_id = ?").bind(STREAM_ID, CHANNEL_ID).run();
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify(customSettings), CHANNEL_ID).run();
  };
  const markSubmitted = async (requestId: string, now = NOW): Promise<void> => {
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId, fromState: "charging", toState: "approved", chargedAmount: 1, chargedAt: now, now });
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now });
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now });
  };

  it("keeps concurrent inserts within the configured channel cap", async () => {
    await database.prepare("DELETE FROM song_requests WHERE channel_id = ?").bind(CHANNEL_ID).run();
    const results = await Promise.all(Array.from({ length: 24 }, (_value, index) =>
      admitSongRequest(database, requestInput(index))));
    const openCount = await database.prepare(
      "SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND state IN ('charging', 'pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')",
    ).bind(CHANNEL_ID).first<{ count: number }>();
    expect(results.filter((result) => result.accepted)).toHaveLength(10);
    expect(openCount?.count).toBe(10);
  });

  it("holds paid admissions in charging while hiding them from queues and counting them toward caps", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      artistOpenLimitEnabled: false,
      channelOpenLimit: 1,
    } });
    await configure(customSettings);
    const first = requestInput(89, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    expect(await database.prepare("SELECT state FROM song_requests WHERE id = ?").bind(first.requestId).first())
      .toEqual({ state: "charging" });
    expect((await pendingSongRequestQueue(database, CHANNEL_ID, STREAM_ID)).requests).toHaveLength(0);
    expect(await readSongRequestQueueState(database, CHANNEL_ID)).toMatchObject({ rows: [] });

    const second = requestInput(88, customSettings);
    expect((await admitSongRequest(database, second)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, second)).code).toBe("channel_open_limit");
  });

  it("does not insert a duplicate open track", async () => {
    await configure(settings);
    const first = requestInput(90);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    expect((await admitSongRequest(database, { ...requestInput(91), track: first.track })).accepted).toBe(false);
  });

  it("admits an older channel-points request after a newer request has already passed admission", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      songCooldownEnabled: true,
      songCooldownMinutes: 60,
      personCooldownEnabled: true,
      personCooldownMinutes: 5,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: true,
      personRoundLimit: 1,
      channelOpenLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const older = {
      ...requestInput(180, customSettings),
      requestType: "channel_points" as const,
      channelPointsRewardId: "reward-admission-order",
      rewardMaxPerUserPerStream: 1,
      rewardGlobalCooldownSeconds: 30,
      now: "2026-11-15T19:59:00.000Z",
    };
    const newer = {
      ...requestInput(181, customSettings),
      requestType: "channel_points" as const,
      channelPointsRewardId: older.channelPointsRewardId,
      rewardMaxPerUserPerStream: older.rewardMaxPerUserPerStream,
      rewardGlobalCooldownSeconds: older.rewardGlobalCooldownSeconds,
      requesterUserId: older.requesterUserId,
      requesterLogin: older.requesterLogin,
      requesterDisplayName: older.requesterDisplayName,
      track: older.track,
      now: "2026-11-15T20:00:00.000Z",
    };

    expect((await admitSongRequest(database, newer)).accepted).toBe(true);
    expect(await transitionRequest(database, {
      channelId: CHANNEL_ID, requestId: newer.requestId, fromState: "approved", toState: "submitting", now: newer.now,
    })).toBe(true);
    expect(await transitionRequest(database, {
      channelId: CHANNEL_ID, requestId: newer.requestId, fromState: "submitting", toState: "submitted", now: newer.now,
    })).toBe(true);
    expect((await admitSongRequest(database, older)).accepted).toBe(true);
  });

  it("rejects an older retried request when a newer one already took the last open slot", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      songCooldownEnabled: false,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: true,
      channelOpenLimit: 1,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const older = { ...requestInput(184, customSettings), now: "2026-11-15T19:59:00.000Z" };
    const newer = { ...requestInput(185, customSettings), now: "2026-11-15T20:00:00.000Z" };

    expect((await admitSongRequest(database, newer)).accepted).toBe(true);
    expect((await admitSongRequest(database, older)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, older)).code).toBe("channel_open_limit");
  });

  it("rejects an older retried request for a track a newer request already queued", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: true,
      songCooldownEnabled: false,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const older = { ...requestInput(186, customSettings), now: "2026-11-15T19:59:00.000Z" };
    const newer = { ...requestInput(187, customSettings), track: older.track, now: "2026-11-15T20:00:00.000Z" };

    expect((await admitSongRequest(database, newer)).accepted).toBe(true);
    expect((await admitSongRequest(database, older)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, older)).code).toBe("already_requested");
  });

  it("rejects an in-order channel-points request inside the reward cooldown window", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      songCooldownEnabled: false,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const earlier = {
      ...requestInput(182, customSettings),
      requestType: "channel_points" as const,
      channelPointsRewardId: "reward-in-order-cooldown",
      rewardGlobalCooldownSeconds: 30,
      now: "2026-11-15T19:59:00.000Z",
    };
    const later = {
      ...requestInput(183, customSettings),
      requestType: "channel_points" as const,
      channelPointsRewardId: earlier.channelPointsRewardId,
      rewardGlobalCooldownSeconds: earlier.rewardGlobalCooldownSeconds,
      now: "2026-11-15T19:59:15.000Z",
    };

    expect((await admitSongRequest(database, earlier)).accepted).toBe(true);
    expect((await admitSongRequest(database, later)).accepted).toBe(false);
  });

  it.each([
    { name: "explicit permission", settings: { rules: { explicitAllowed: false } }, track: { explicit: true }, expected: "explicit_not_allowed" },
    { name: "maximum track length", settings: { rules: { maxTrackLengthMinutes: 2 } }, track: {}, expected: "track_too_long" },
    { name: "blocked track list", settings: { rules: { blockTracksEnabled: true, blockedTrackIds: ["trackconcurrent102"] } }, track: {}, expected: "track_blocked" },
    { name: "blocked artist list", settings: { rules: { blockArtistsEnabled: true, blockedArtists: ["Mira Vale"] } }, track: {}, expected: "artist_blocked" },
  ])("rejects tracks that fail the $name rule in the guarded insert", async ({ settings: rawSettings, track, expected }) => {
    const customSettings = songRequestsSettingsSchema.parse(rawSettings);
    await configure(customSettings);
    const input = { ...requestInput(102, customSettings), track: { ...requestInput(102).track, ...track } };
    expect((await admitSongRequest(database, input)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, input)).code).toBe(expected);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ?").bind(CHANNEL_ID).first())
      .toEqual({ count: 0 });
  });

  it.each([
    { name: "person cooldown", settings: { rules: { personCooldownEnabled: true, personCooldownMinutes: 5 } }, expected: "person_cooldown" },
    { name: "person open limit", settings: { rules: { personCooldownEnabled: false, personOpenLimit: 1, personRoundLimitEnabled: false } }, expected: "person_open_limit" },
    { name: "per-round person limit", settings: { rules: { personCooldownEnabled: false, personOpenLimitEnabled: false, personRoundLimit: 1 } }, expected: "person_round_limit" },
    { name: "channel open cap", settings: { rules: { personCooldownEnabled: false, personOpenLimitEnabled: false, personRoundLimitEnabled: false, channelOpenLimit: 1 } }, expected: "channel_open_limit" },
  ])("enforces the $name rule before a second insert", async ({ settings: rawSettings, expected }) => {
    const customSettings = songRequestsSettingsSchema.parse(rawSettings);
    await configure(customSettings);
    const first = requestInput(110, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    const second = { ...requestInput(111, customSettings), requesterUserId: first.requesterUserId };
    expect((await admitSongRequest(database, second)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, second)).code).toBe(expected);
  });

  it("counts a submitted song against once-per-round cooldown", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: { duplicateEnabled: false, songCooldownOncePerRound: true } });
    await configure(customSettings);
    const first = requestInput(120, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);
    const second = { ...requestInput(121, customSettings), track: first.track };
    expect((await admitSongRequest(database, second)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, second)).code).toBe("song_cooldown");
  });

  it("keeps a cleared submitted live request reserved as removed until the round ends", async () => {
    const defaults = songRequestsSettingsSchema.parse({});
    await configure(defaults);
    const first = requestInput(122, defaults);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);

    const cleanup = await cleanupSongRequestRound(database, CHANNEL_ID, STREAM_ID, NOW, "list_cleared");

    expect(cleanup.refundableRequestIds).not.toContain(first.requestId);
    expect(await database.prepare("SELECT state, submitted_at FROM song_requests WHERE id = ?")
      .bind(first.requestId).first()).toEqual({ state: "removed", submitted_at: NOW });
  });

  it("keeps the personal cooldown after playback starts and releases a rejected uncharged request", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      personCooldownEnabled: true,
      personCooldownMinutes: 5,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const played = requestInput(123, customSettings);
    expect((await admitSongRequest(database, played)).accepted).toBe(true);
    await markSubmitted(played.requestId);
    await transitionRequest(database, {
      channelId: CHANNEL_ID, requestId: played.requestId, fromState: "submitted", toState: "observed_playing", now: NOW,
    });
    const cooledDown = { ...requestInput(124, customSettings), requesterUserId: played.requesterUserId };
    expect((await admitSongRequest(database, cooledDown)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, cooledDown)).code).toBe("person_cooldown");

    const rejected = { ...requestInput(127, customSettings), requesterUserId: "viewer-rejected-before-charge" };
    expect((await admitSongRequest(database, rejected)).accepted).toBe(true);
    await transitionRequest(database, {
      channelId: CHANNEL_ID, requestId: rejected.requestId, fromState: "charging", toState: "failed", now: NOW,
    });
    const retry = { ...requestInput(128, customSettings), requesterUserId: rejected.requesterUserId };
    expect((await admitSongRequest(database, retry)).accepted).toBe(true);
  });

  it("counts a submitted song against the configured minute cooldown and releases it after the window", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      songCooldownEnabled: true,
      songCooldownMinutes: 60,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const first = requestInput(125, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);
    const stillCooling = { ...requestInput(126, customSettings), track: first.track };
    expect((await admitSongRequest(database, stillCooling)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, stillCooling)).code).toBe("song_cooldown");

    const later = { ...requestInput(127, customSettings), track: first.track, now: "2026-11-15T21:01:00.000Z" };
    expect((await admitSongRequest(database, later)).accepted).toBe(true);
  });

  it("keeps the minute-based song cooldown across round boundaries", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      songCooldownEnabled: true,
      songCooldownOncePerRound: false,
      songCooldownMinutes: 60,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const first = requestInput(125, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);

    await database.prepare("UPDATE channel_stream_state SET stream_id = ? WHERE channel_id = ?")
      .bind("stream-admission-next", CHANNEL_ID).run();
    const nextRound = {
      ...requestInput(126, customSettings),
      streamId: "stream-admission-next",
      roundId: "stream-admission-next",
      track: first.track,
      now: "2026-11-15T20:30:00.000Z",
    };

    expect((await admitSongRequest(database, nextRound)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, nextRound)).code).toBe("song_cooldown");
  });

  it("counts a submitted artist against the open artist cap", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      duplicateEnabled: false,
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      channelOpenLimitEnabled: false,
      artistOpenLimit: 1,
    } });
    await configure(customSettings);
    const first = requestInput(130, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId: first.requestId, fromState: "submitted", toState: "removed", now: NOW });
    const second = requestInput(131, customSettings);
    expect((await admitSongRequest(database, second)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, second)).code).toBe("artist_open_limit");
  });

  it("counts a removed submitted track against duplicate prevention until the round ends", async () => {
    const customSettings = songRequestsSettingsSchema.parse({ rules: {
      personCooldownEnabled: false,
      personOpenLimitEnabled: false,
      personRoundLimitEnabled: false,
      artistOpenLimitEnabled: false,
    } });
    await configure(customSettings);
    const first = requestInput(140, customSettings);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    await markSubmitted(first.requestId);
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId: first.requestId, fromState: "submitted", toState: "removed", now: NOW });
    const second = { ...requestInput(141, customSettings), track: first.track };
    expect((await admitSongRequest(database, second)).accepted).toBe(false);
    expect((await songRequestAdmissionFailure(database, second)).code).toBe("already_requested");
  });

  it("rejects offline admission by default and admits into the guarded offline round when enabled", async () => {
    const disabled = songRequestsSettingsSchema.parse({
      alsoOffline: false,
      rules: {
        personCooldownEnabled: false,
        personOpenLimitEnabled: false,
        personRoundLimitEnabled: false,
      },
    });
    await configure(disabled);
    await database.prepare("UPDATE channel_stream_state SET state = 'offline', stream_id = NULL WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    const offlineRoundId = "offline-admission-round";
    await database.prepare("INSERT INTO song_requests_offline_rounds (channel_id, round_id, created_at) VALUES (?, ?, ?)")
      .bind(CHANNEL_ID, offlineRoundId, NOW).run();
    const offlineInput = (customSettings: ReturnType<typeof songRequestsSettingsSchema.parse>, index: number) => ({
      ...requestInput(index, customSettings),
      streamId: null,
      roundId: offlineRoundId,
    });
    expect((await admitSongRequest(database, offlineInput(disabled, 150))).accepted).toBe(false);

    const enabled = songRequestsSettingsSchema.parse({ ...disabled, alsoOffline: true });
    await configure(enabled);
    await database.prepare("UPDATE channel_stream_state SET state = 'offline', stream_id = NULL WHERE channel_id = ?")
      .bind(CHANNEL_ID).run();
    expect((await admitSongRequest(database, offlineInput(enabled, 151))).accepted).toBe(true);
  });
});

describe("song request points ledger on a real ChannelObject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("charges and refunds with zero-sum movements in the real points ledger", async () => {
    const channelId = "song-requests-real-ledger";
    const requestSettings = songRequestsSettingsSchema.parse({
      paymentMode: "bot_points",
      botPointsCost: 13,
      mode: "moderated",
      rules: { personCooldownEnabled: false, personOpenLimitEnabled: false, personRoundLimitEnabled: false },
    });
    const requestSettingsJson = JSON.stringify(requestSettings);
    await database.prepare("INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(channelId, channelId, channelId, NOW, NOW).run();
    await database.batch([
      database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'song_requests', 1, ?, 1)")
        .bind(channelId, requestSettingsJson),
      database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, '{}', 1)")
        .bind(channelId),
      database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES ((SELECT COALESCE(MAX(slot), 0) + 1 FROM spotify_channel_access), ?, 'operator', ?)")
        .bind(channelId, NOW),
      database.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', ?)")
        .bind(channelId, NOW, "stream-real-ledger"),
      database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'connected', ?)")
        .bind(channelId, NOW),
    ]);

    const namespace = (env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL;
    const points = modulePoints(namespace, channelId, "song_requests");
    await points.touchAccount("viewer-real-ledger", "ledger_viewer", 100);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ tracks: { items: [ledgerTrack] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const event: ModuleEvent<SongRequestsSettings> = {
      channelId,
      subscriptionType: "channel.chat.message",
      triggerId: "real-ledger-message",
      payload: {
        chatter_user_id: "viewer-real-ledger",
        chatter_user_login: "ledger_viewer",
        chatter_user_name: "Ledger Viewer",
        message_id: "real-ledger-message",
        message: { text: "!sr Ledger Track", fragments: [{ type: "text", text: "!sr Ledger Track" }] },
      },
      settings: requestSettings,
      receivedAt: NOW,
      actor: null,
      chatStatus: ["viewer"],
    };
    const context = {
      DB: database,
      channelId,
      environment: {
        APP_ENV: "test",
        CHANNEL: { idFromName: (name: string) => name, get: () => ({ getSpotifyAccessToken: () => Promise.resolve("spotify-access-fixture") }) },
      },
      points,
      channelLanguage: () => Promise.resolve("en"),
      botUserId: () => Promise.resolve("bot-fixture"),
      scheduleAlarm: () => Promise.resolve(),
    } as unknown as ModuleExecutionContext;

    const accepted = await processSongRequestsEvent(event, context);
    const request = await database.prepare("SELECT id FROM song_requests WHERE channel_id = ?")
      .bind(channelId).first<{ id: string }>();
    expect(accepted.actions[0]).toMatchObject({ kind: "chat", automated: false });
    expect(JSON.stringify(accepted.actions[0])).toContain("accepted");
    expect(await points.balance("viewer-real-ledger")).toBe(87);
    if (request === null) throw new Error("The paid song request was not recorded.");
    expect(await points.getOperation(songRequestChargeOperationId(request.id))).toMatchObject({ kind: "stake" });

    expect(await transitionRequest(database, {
      channelId, requestId: request.id, fromState: "pending_review", toState: "rejected", refundDue: true, now: NOW,
    })).toBe(true);
    await refundRequestId({ DB: database, channelId, points }, request.id);

    expect(await points.balance("viewer-real-ledger")).toBe(100);
    expect(await points.getOperation(songRequestRefundOperationId(request.id))).toMatchObject({ kind: "refund" });

    const cancelledRequestId = "real-ledger-cancelled-charge";
    await transitionRequest(database, {
      channelId,
      requestId: cancelledRequestId,
      fromState: null,
      toState: "charging",
      now: "2000-01-01T00:00:00.000Z",
      newRequest: {
        source: "points",
        requestType: "bot_points",
        track: {
          id: "cancelled-track",
          uri: "spotify:track:cancelled-track",
          title: "Cancelled Track",
          artists: [],
          durationMs: 100_000,
          explicit: false,
          coverUrl: null,
          spotifyUrl: "https://open.spotify.com/track/cancelled-track",
        },
        operationId: `sr:${cancelledRequestId}`,
        streamId: "stream-real-ledger",
        roundId: "stream-real-ledger",
        chargedAmount: 13,
        requesterUserId: "viewer-real-ledger",
        requesterLogin: "ledger_viewer",
        requesterDisplayName: "Ledger Viewer",
      },
    });
    await database.prepare("UPDATE song_requests SET charging_since = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(cancelledRequestId).run();

    expect(await reconcileStaleSongRequestCharges({ DB: database, channelId, points }, Date.now())).toBe(1);
    expect(await database.prepare("SELECT state, refund_due FROM song_requests WHERE id = ?")
      .bind(cancelledRequestId).first()).toEqual({ state: "failed", refund_due: 0 });
    const cancelledOperationId = songRequestChargeOperationId(cancelledRequestId);
    expect(await points.getOperation(cancelledOperationId)).toMatchObject({
      kind: "refund",
      result: { requestId: cancelledRequestId, cancelled: true },
    });
    let lateStakeError: unknown = null;
    try {
      await points.apply(cancelledOperationId, "stake", [
        { accountId: "viewer-real-ledger", login: "ledger_viewer", delta: -13 },
        { accountId: "__house", delta: 13 },
      ], { requestId: cancelledRequestId, trackId: "late-track", amount: 13 }, { requestId: cancelledRequestId });
    } catch (error) {
      lateStakeError = error;
    }
    expect(lateStakeError).toBeInstanceOf(Error);
    expect((lateStakeError as Error).message).toContain("operation_conflict");
    expect(await points.balance("viewer-real-ledger")).toBe(100);
  });
});
