import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { createNowPlayingSnapshot, createVoteRequestClaim } from "../../src/modules/song_requests/adapters/d1";
import type { SpotifyTrack } from "../../src/modules/song_requests/domain/track";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { holdSubmitClaim } from "../../src/modules/song_requests/service";

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
const NOW = "2026-11-15T12:00:00.000Z";

beforeAll(async () => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    for (const statement of migrationStatements(migrationSources[path] ?? "")) await database.prepare(statement).run();
  }
});

const seed = async (channelId: string): Promise<void> => {
  await database.prepare("DELETE FROM song_requests").run();
  await database.prepare("DELETE FROM spotify_channel_access").run();
  await database.batch([
    database.prepare("INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(channelId, channelId, channelId, NOW, NOW),
    database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'song_requests', 1, '{}', 1)")
      .bind(channelId),
    database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES ((SELECT COALESCE(MAX(slot), 0) + 1 FROM spotify_channel_access), ?, 'operator', ?)")
      .bind(channelId, NOW),
    database.prepare("INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id) VALUES (?, 'online', ?, 'eventsub', 'stream-1')")
      .bind(channelId, NOW),
    database.prepare(
      `INSERT INTO song_requests (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit,
         spotify_url, state, operation_id, stream_id, round_id, created_at, updated_at)
       VALUES ('request-1', ?, 'mod_vote', 'track-1', 'spotify:track:track-1', 'Glass Harbor', '["Mira Vale"]', 200000, 0,
         'https://open.spotify.com/track/track-1', 'submitting', 'operation-1', 'stream-1', 'stream-1', ?, ?)`,
    ).bind(channelId, NOW, NOW),
  ]);
};

const seedOffline = async (channelId: string, alsoOffline: boolean): Promise<string> => {
  await seed(channelId);
  const roundId = `offline-round-${channelId}`;
  await database.batch([
    database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify({ alsoOffline }), channelId),
    database.prepare("UPDATE channel_stream_state SET state = 'offline', stream_id = NULL WHERE channel_id = ?")
      .bind(channelId),
    database.prepare("INSERT INTO song_requests_offline_rounds (channel_id, round_id, created_at) VALUES (?, ?, ?)")
      .bind(channelId, roundId, NOW),
    database.prepare("UPDATE song_requests SET stream_id = NULL, round_id = ? WHERE channel_id = ? AND id = 'request-1'")
      .bind(roundId, channelId),
  ]);
  return roundId;
};

const spotifyTrack: SpotifyTrack = {
  id: "glassharbor01",
  uri: "spotify:track:glassharbor01",
  name: "Glass Harbor",
  duration_ms: 201_000,
  explicit: false,
  artists: [{ id: "miravale01", name: "Mira Vale" }],
  album: { name: "Quiet Atlas", images: [{ url: "https://i.scdn.co/image/fictional-cover", width: 640, height: 640 }] },
  external_urls: { spotify: "https://open.spotify.com/track/glassharbor01" },
};

const requestsRevision = async (channelId: string): Promise<number> => (await database.prepare(
  "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:song_requests:requests'",
).bind(channelId).first<{ revision: number }>())?.revision ?? 0;

describe("submit claim guard on real D1", () => {
  it("passes only while claim, activation, slot and live stream all match, and never bumps the panel revision", async () => {
    const channelId = "guard-pass";
    await seed(channelId);
    const before = await requestsRevision(channelId);
    expect(await holdSubmitClaim(database, channelId, "request-1", "stream-1")).toBe(true);
    expect(await requestsRevision(channelId)).toBe(before);

    expect(await holdSubmitClaim(database, channelId, "request-1", "stream-other")).toBe(false);
    expect(await holdSubmitClaim(database, channelId, "request-1", null)).toBe(false);
    expect(await holdSubmitClaim(database, channelId, "request-missing", "stream-1")).toBe(false);

    await database.prepare("UPDATE channel_stream_state SET state = 'offline' WHERE channel_id = ?").bind(channelId).run();
    expect(await holdSubmitClaim(database, channelId, "request-1", "stream-1")).toBe(false);
    await database.prepare("UPDATE channel_stream_state SET state = 'online' WHERE channel_id = ?").bind(channelId).run();
    expect(await holdSubmitClaim(database, channelId, "request-1", "stream-1")).toBe(true);
  });

  it("fails after deactivation, slot revocation or a changed claim even though revision triggers write rows", async () => {
    for (const [channelId, breakIt] of [
      ["guard-module", "UPDATE channel_modules SET enabled = 0 WHERE channel_id = ?"],
      ["guard-slot", "DELETE FROM spotify_channel_access WHERE channel_id = ?"],
      ["guard-claim", "UPDATE song_requests SET state = 'failed', failure_reason = 'x' WHERE channel_id = ?"],
    ] as const) {
      await seed(channelId);
      expect(await holdSubmitClaim(database, channelId, "request-1", "stream-1")).toBe(true);
      await database.prepare(breakIt).bind(channelId).run();
      expect(await holdSubmitClaim(database, channelId, "request-1", "stream-1")).toBe(false);
    }
  });

  it("accepts the offline round only while Also offline is enabled", async () => {
    const offChannel = "guard-offline-disabled";
    const offRoundId = await seedOffline(offChannel, false);
    expect(await holdSubmitClaim(database, offChannel, "request-1", offRoundId)).toBe(false);

    const onChannel = "guard-offline-enabled";
    const onRoundId = await seedOffline(onChannel, true);
    const before = await requestsRevision(onChannel);
    expect(await holdSubmitClaim(database, onChannel, "request-1", onRoundId)).toBe(true);
    expect(await requestsRevision(onChannel)).toBe(before);
    expect(await holdSubmitClaim(database, onChannel, "request-1", "offline-round-stale")).toBe(false);
  });

  it("does not let a second stale Clear list close a replacement offline round", async () => {
    const channelId = "guard-overlapping-offline-clear";
    const originalRoundId = await seedOffline(channelId, true);
    const replacementRoundId = "offline-round-replacement";
    let replacementCreated = false;
    let currentRoundReads = 0;
    let closeRoundReads = 0;
    let releaseRoundReads!: () => void;
    const roundReadsReady = new Promise<void>((resolve) => { releaseRoundReads = resolve; });
    let releaseReplacementCreated!: () => void;
    const replacementCreatedPromise = new Promise<void>((resolve) => { releaseReplacementCreated = resolve; });

    const createReplacementRound = async (): Promise<void> => {
      if (replacementCreated) return;
      replacementCreated = true;
      await database.batch([
        database.prepare("INSERT INTO song_requests_offline_rounds (channel_id, round_id, created_at) VALUES (?, ?, ?)")
          .bind(channelId, replacementRoundId, NOW),
        database.prepare(
          `INSERT INTO song_requests (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit,
             spotify_url, state, operation_id, request_type, charged_amount, stream_id, round_id, created_at, updated_at)
           VALUES ('request-in-replacement-round', ?, 'points', 'replacement-track', 'spotify:track:replacement-track',
             'Replacement Track', '[]', 180000, 0, 'https://open.spotify.com/track/replacement-track',
             'pending_review', 'operation-replacement-round', 'free', 0, NULL, ?, ?, ?)`,
        ).bind(channelId, replacementRoundId, NOW, NOW),
      ]);
      releaseReplacementCreated();
    };

    const interleavingDatabase = {
      prepare: (sql: string) => {
        let statement = database.prepare(sql);
        const wrapped = {
          unwrap: () => statement,
          bind: (...values: Parameters<typeof statement.bind>) => {
            statement = statement.bind(...values);
            return wrapped;
          },
          first: async <T>() => {
            if (sql.includes("SELECT round_id FROM song_requests_offline_rounds") && currentRoundReads < 2) {
              const value = await statement.first<T>();
              currentRoundReads += 1;
              if (currentRoundReads === 2) releaseRoundReads();
              await roundReadsReady;
              return value;
            }
            if (sql.includes("SELECT round_id FROM song_requests_offline_rounds")) {
              closeRoundReads += 1;
              if (closeRoundReads === 2) await replacementCreatedPromise;
            }
            const value = await statement.first<T>();
            if (sql.startsWith("DELETE FROM song_requests_offline_rounds") && value !== null) await createReplacementRound();
            return value;
          },
          all: <T>() => statement.all<T>(),
          run: async () => {
            const result = await statement.run();
            if (sql.startsWith("DELETE FROM song_requests_offline_rounds") && result.meta.changes > 0) await createReplacementRound();
            return result;
          },
        };
        return wrapped;
      },
      batch: (statements: readonly { unwrap?: () => D1PreparedStatement }[]) =>
        database.batch(statements.map((candidate) => candidate.unwrap?.() ?? (candidate as unknown as D1PreparedStatement))),
    } as unknown as D1Database;

    const points = {
      apply: () => Promise.reject(new Error("No paid request is expected in this route test.")),
      getOperation: () => Promise.resolve(null),
    } as unknown as ModulePointsAccess;
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => {
      context.set("channelRole", "operator");
      context.set("points", () => points);
      context.set("publishModuleOverlayMessage", () => Promise.resolve());
      await next();
    });
    app.route("/channels/:channelId", songRequestsRoutes);
    const request = async (): Promise<Response> => await app.fetch(
      new Request(`https://brobot.example/channels/${channelId}/clear`, { method: "POST" }),
      { DB: interleavingDatabase },
    );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map(async (response) => await response.json()))).toContainEqual({ cleared: false });
    expect(await database.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
      .bind(channelId).first()).toEqual({ round_id: replacementRoundId });
    expect(await database.prepare("SELECT state, round_id FROM song_requests WHERE id = 'request-in-replacement-round'").first())
      .toEqual({ state: "pending_review", round_id: replacementRoundId });
    expect(originalRoundId).not.toBe(replacementRoundId);
  });

  it("commits the poll snapshot only for the current enabled offline round", async () => {
    const channelId = "guard-offline-poll";
    const roundId = await seedOffline(channelId, true);
    const first = await createNowPlayingSnapshot(database, channelId, roundId, spotifyTrack, NOW, 5_000, { offlineRoundId: roundId });
    expect(first).toMatchObject({ changed: true, committed: true, state: { title: "Glass Harbor" } });

    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify({ alsoOffline: false }), channelId).run();
    const stopped = await createNowPlayingSnapshot(database, channelId, roundId, { ...spotifyTrack, id: "quietatlas02", uri: "spotify:track:quietatlas02", name: "Quiet Atlas" }, NOW, 7_000, { offlineRoundId: roundId });
    expect(stopped).toMatchObject({ changed: false, committed: false });

    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(JSON.stringify({ alsoOffline: true }), channelId).run();
    await database.prepare("DELETE FROM song_requests_offline_rounds WHERE channel_id = ?").bind(channelId).run();
    const ended = await createNowPlayingSnapshot(database, channelId, roundId, { ...spotifyTrack, id: "quietatlas02", uri: "spotify:track:quietatlas02", name: "Quiet Atlas" }, NOW, 7_000, { offlineRoundId: roundId });
    expect(ended).toMatchObject({ changed: false, committed: false });
  });

  it("claims offline vote results only while the persisted round is still enabled", async () => {
    const onChannel = "guard-offline-vote-enabled";
    const onRoundId = await seedOffline(onChannel, true);
    await database.prepare(
      `INSERT INTO song_requests_votes (ballot_id, channel_id, stream_id, round_id, candidate_tracks_json,
         moderator_user_id, state, created_at) VALUES ('ballot-offline-on', ?, NULL, ?, '[]', 'moderator-fictional', 'open', ?)`,
    ).bind(onChannel, onRoundId, NOW).run();
    const track = {
      id: "offlinevotetrack01", uri: "spotify:track:offlinevotetrack01", title: "Offline Vote Track",
      artists: ["Mira Vale"], durationMs: 201_000, explicit: false, coverUrl: null,
      spotifyUrl: "https://open.spotify.com/track/offlinevotetrack01",
    };
    expect(await createVoteRequestClaim(database, {
      channelId: onChannel, ballotId: "ballot-offline-on", moderatorUserId: "moderator-fictional", track,
      streamId: null, roundId: onRoundId, activeRoundId: onRoundId, requestId: "offline-vote-request-on", now: NOW,
    })).toBe(true);
    expect(await database.prepare("SELECT state, stream_id, round_id FROM song_requests WHERE id = 'offline-vote-request-on'").first())
      .toEqual({ state: "approved", stream_id: null, round_id: onRoundId });

    const offChannel = "guard-offline-vote-disabled";
    const offRoundId = await seedOffline(offChannel, false);
    await database.prepare(
      `INSERT INTO song_requests_votes (ballot_id, channel_id, stream_id, round_id, candidate_tracks_json,
         moderator_user_id, state, created_at) VALUES ('ballot-offline-off', ?, NULL, ?, '[]', 'moderator-fictional', 'open', ?)`,
    ).bind(offChannel, offRoundId, NOW).run();
    expect(await createVoteRequestClaim(database, {
      channelId: offChannel, ballotId: "ballot-offline-off", moderatorUserId: "moderator-fictional", track,
      streamId: null, roundId: offRoundId, activeRoundId: offRoundId, requestId: "offline-vote-request-off", now: NOW,
    })).toBe(false);
    expect(await database.prepare("SELECT state FROM song_requests_votes WHERE ballot_id = 'ballot-offline-off'").first())
      .toEqual({ state: "open" });
    expect(await database.prepare("SELECT id FROM song_requests WHERE id = 'offline-vote-request-off'").first()).toBeNull();
  });
});

describe("connection revision trigger on real D1", () => {
  it("bumps the connection revision only when a panel-visible value changes", async () => {
    const channelId = "guard-connection";
    await seed(channelId);
    await database.prepare("INSERT INTO song_requests_connections (channel_id, state, updated_at) VALUES (?, 'not_connected', ?)")
      .bind(channelId, NOW).run();
    const revision = async (): Promise<number> => (await database.prepare(
      "SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:song_requests:connection'",
    ).bind(channelId).first<{ revision: number }>())?.revision ?? 0;
    const start = await revision();
    await database.prepare("UPDATE song_requests_connections SET updated_at = ?, poll_failures = 3 WHERE channel_id = ?")
      .bind("2026-11-15T13:00:00.000Z", channelId).run();
    expect(await revision()).toBe(start);
    await database.prepare("UPDATE song_requests_connections SET state = 'connected' WHERE channel_id = ?").bind(channelId).run();
    expect(await revision()).toBe(start + 1);
  });
});
