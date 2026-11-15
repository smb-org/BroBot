import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

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
         spotify_url, state, operation_id, stream_id, created_at, updated_at)
       VALUES ('request-1', ?, 'mod_vote', 'track-1', 'spotify:track:track-1', 'Glass Harbor', '["Mira Vale"]', 200000, 0,
         'https://open.spotify.com/track/track-1', 'submitting', 'operation-1', 'stream-1', ?, ?)`,
    ).bind(channelId, NOW, NOW),
  ]);
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
