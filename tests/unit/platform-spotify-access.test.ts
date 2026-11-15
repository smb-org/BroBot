import { afterEach, describe, expect, it } from "vitest";

import { listPlatformSpotifyAccess, setPlatformSpotifyAccess } from "../../src/worker/platform/repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_IDS = ["channel-frostfern", "channel-miravale", "channel-northwindow", "channel-quietatlas", "channel-silvercurrent", "channel-glassharbor"];
const databases: TestD1Database[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("platform Spotify access slots", () => {
  it("limits channel enablement to five slots and reports the occupied count", async () => {
    const database = new TestD1Database();
    databases.push(database);
    for (const channelId of CHANNEL_IDS) await insertChannel(database, channelId);
    const db = database as unknown as D1Database;
    const actor = { userId: "platform-admin-fictional", sessionId: "platform-session-fictional" };
    const results = [];
    for (const channelId of CHANNEL_IDS) {
      results.push(await setPlatformSpotifyAccess(db, actor, channelId, true, "2026-11-15T20:00:00.000Z"));
    }

    expect(results).toEqual(["enabled", "enabled", "enabled", "enabled", "enabled", "limit"]);
    const access = await listPlatformSpotifyAccess(db);
    expect(access.usedSlots).toBe(5);
    expect(access.limit).toBe(5);
    expect(access.channels.map(({ slot }) => slot)).toEqual([1, 2, 3, 4, 5]);
  });

  it("deletes channel Spotify credentials and resets the connection when a slot is revoked", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = CHANNEL_IDS[0] as string;
    await insertChannel(database, channelId);
    const db = database as unknown as D1Database;
    const actor = { userId: "platform-admin-fictional", sessionId: "platform-session-fictional" };
    await setPlatformSpotifyAccess(db, actor, channelId, true, "2026-11-15T20:00:00.000Z");
    await database.prepare(
      "INSERT INTO module_secrets (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by) VALUES (?, 'song_requests', 'spotify_credentials', 'encrypted-fictional', 'key', 1, ?, ?)",
    ).bind(channelId, "2026-11-15T20:00:00.000Z", actor.userId).run();
    await database.prepare(
      "INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at) VALUES (?, 'spotify_error', 'Scope missing', ?)",
    ).bind(channelId, "2026-11-15T20:00:00.000Z").run();

    await setPlatformSpotifyAccess(db, actor, channelId, false, "2026-11-15T21:00:00.000Z");

    expect(await database.prepare("SELECT count(*) AS count FROM module_secrets WHERE channel_id = ? AND module_id = 'song_requests' AND name = 'spotify_credentials'")
      .bind(channelId).first()).toEqual({ count: 0 });
    expect(await database.prepare("SELECT state, error_message FROM song_requests_connections WHERE channel_id = ?")
      .bind(channelId).first()).toEqual({ state: "not_connected", error_message: null });
  });
});
