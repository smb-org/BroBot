import { afterEach, describe, expect, it } from "vitest";

import { drawChapterCandidates } from "../../src/modules/song_requests/domain/chapter-draw";
import type { SongRequestChapterTrack } from "../../src/modules/song_requests/contracts";
import {
  deleteSongRequestChapter,
  excludedSongRequestChapterTrackIds,
  listSongRequestChapters,
  readSongRequestChapter,
  saveSongRequestChapter,
} from "../../src/modules/song_requests/repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "chapter-channel-one";
const ROUND_ID = "stream-fictional-one";
const NOW = "2026-11-18T12:00:00.000Z";
const tracks: SongRequestChapterTrack[] = [
  { id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: "https://i.scdn.co/image/fictional-one" },
  { id: "quietatlas02", title: "Quiet Atlas", artists: ["Mira Vale"], coverUrl: null },
  { id: "silvercurrent03", title: "Silver Current", artists: ["Rowan March"], coverUrl: null },
  { id: "northwindow04", title: "North Window", artists: ["Rowan March"], coverUrl: null },
  { id: "bluehour05", title: "Blue Hour", artists: ["Mira Vale"], coverUrl: null },
];

const databases: TestD1Database[] = [];
const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await insertChannel(database, "chapter-channel-two");
  for (const channelId of [CHANNEL_ID, "chapter-channel-two"]) {
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(channelId).run();
  }
  return database;
};

const insertRequest = async (
  database: TestD1Database,
  id: string,
  trackId: string,
  state: string,
  roundId: string,
  submittedAt: string | null,
  channelId = CHANNEL_ID,
): Promise<void> => {
  await database.prepare(`INSERT INTO song_requests
    (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, spotify_url,
     state, operation_id, stream_id, round_id, submitted_at, created_at, updated_at)
    VALUES (?, ?, 'points', ?, ?, ?, '[]', 1000, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, channelId, trackId, `spotify:track:${trackId}`, id, `https://open.spotify.com/track/${trackId}`,
      state, `operation-${id}`, roundId, roundId, submittedAt, NOW, NOW).run();
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("song request chapters", () => {
  it("creates, lists, updates, deletes, and scopes chapter records by channel", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    const saved = await saveSongRequestChapter(db, CHANNEL_ID, null, null, {
      name: "Night Drive", tracks: tracks.slice(0, 3), offerInCockpit: true,
    }, NOW);
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected a saved chapter.");
    expect(await readSongRequestChapter(db, "chapter-channel-two", saved.chapter.id)).toBeNull();
    expect(await listSongRequestChapters(db, "chapter-channel-two")).toEqual([]);
    expect(await listSongRequestChapters(db, CHANNEL_ID, true)).toEqual([saved.chapter]);

    const updated = await saveSongRequestChapter(db, CHANNEL_ID, saved.chapter.id, saved.chapter.revision, {
      name: "Late Drive", tracks: tracks.slice(0, 2), offerInCockpit: false,
    }, "2026-11-18T12:05:00.000Z");
    expect(updated.status).toBe("saved");
    if (updated.status !== "saved") throw new Error("Expected an updated chapter.");
    expect(updated.chapter).toMatchObject({ name: "Late Drive", offerInCockpit: false, revision: 2 });
    expect(await deleteSongRequestChapter(db, "chapter-channel-two", saved.chapter.id, updated.chapter.revision)).toBe("missing");
    expect(await deleteSongRequestChapter(db, CHANNEL_ID, saved.chapter.id, updated.chapter.revision)).toBe("deleted");
    expect(await readSongRequestChapter(db, CHANNEL_ID, saved.chapter.id)).toBeNull();
  });

  it("draws three candidates, preserves a two-track pool, and leaves fewer than two for the caller to reject", () => {
    const calls: number[] = [];
    const randomLast = (maximum: number): number => { calls.push(maximum); return maximum - 1; };
    expect(drawChapterCandidates(tracks, new Set(["quietatlas02"]), randomLast).map(({ id }) => id))
      .toEqual(["bluehour05", "northwindow04", "silvercurrent03"]);
    expect(calls).toEqual([4, 3, 2]);
    expect(drawChapterCandidates(tracks.slice(0, 2), new Set(), () => 0)).toHaveLength(2);
    expect(drawChapterCandidates(tracks.slice(0, 1), new Set(), () => 0)).toHaveLength(1);
  });

  it("excludes current-round ledger rows except rejected or failed and applies configured cooldowns", async () => {
    const database = await createDatabase();
    const db = database as unknown as D1Database;
    await insertRequest(database, "requested-one", tracks[0]?.id ?? "", "submitted", ROUND_ID, NOW);
    await insertRequest(database, "played-two", tracks[1]?.id ?? "", "observed_playing", ROUND_ID, NOW);
    await insertRequest(database, "rejected-three", tracks[2]?.id ?? "", "rejected", ROUND_ID, null);
    await insertRequest(database, "failed-four", tracks[3]?.id ?? "", "failed", ROUND_ID, null);
    await insertRequest(database, "cooldown-five", tracks[4]?.id ?? "", "observed_playing", "stream-fictional-old", "2026-11-18T11:30:00.000Z");

    const disabledCooldown = await excludedSongRequestChapterTrackIds(db, CHANNEL_ID, ROUND_ID, tracks, {
      songCooldownEnabled: false, songCooldownOncePerRound: false, songCooldownMinutes: 60,
    }, NOW);
    expect(disabledCooldown).toEqual(new Set([tracks[0]?.id, tracks[1]?.id]));
    const minuteCooldown = await excludedSongRequestChapterTrackIds(db, CHANNEL_ID, ROUND_ID, tracks, {
      songCooldownEnabled: true, songCooldownOncePerRound: false, songCooldownMinutes: 60,
    }, NOW);
    expect(minuteCooldown).toEqual(new Set([tracks[0]?.id, tracks[1]?.id, tracks[4]?.id]));
    const otherChannel = await excludedSongRequestChapterTrackIds(db, "chapter-channel-two", ROUND_ID, tracks, {
      songCooldownEnabled: false, songCooldownOncePerRound: false, songCooldownMinutes: 60,
    }, NOW);
    expect(otherChannel).toEqual(new Set());
  });
});
