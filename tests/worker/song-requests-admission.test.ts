import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { admitSongRequest, songRequestAdmissionFailure, transitionRequest } from "../../src/modules/song_requests/adapters/d1";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";

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
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify(customSettings), CHANNEL_ID).run();
  };
  const markSubmitted = async (requestId: string, now = NOW): Promise<void> => {
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId, fromState: "approved", toState: "submitting", now });
    await transitionRequest(database, { channelId: CHANNEL_ID, requestId, fromState: "submitting", toState: "submitted", now });
  };

  it("keeps concurrent inserts within the configured channel cap", async () => {
    await database.prepare("DELETE FROM song_requests WHERE channel_id = ?").bind(CHANNEL_ID).run();
    const results = await Promise.all(Array.from({ length: 24 }, (_value, index) =>
      admitSongRequest(database, requestInput(index))));
    const openCount = await database.prepare(
      "SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')",
    ).bind(CHANNEL_ID).first<{ count: number }>();
    expect(results.filter((result) => result.accepted)).toHaveLength(10);
    expect(openCount?.count).toBe(10);
  });

  it("does not insert a duplicate open track", async () => {
    await database.prepare("DELETE FROM song_requests WHERE channel_id = ?").bind(CHANNEL_ID).run();
    const first = requestInput(90);
    expect((await admitSongRequest(database, first)).accepted).toBe(true);
    expect((await admitSongRequest(database, { ...requestInput(91), track: first.track })).accepted).toBe(false);
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
    expect((await admitSongRequest(database, offlineInput(enabled, 151))).accepted).toBe(true);
  });
});
