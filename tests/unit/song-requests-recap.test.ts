import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleExecutionContext } from "../../src/modules/contract";
import { songRequestChatTexts } from "../../src/modules/song_requests/chat-locale";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";
import { songRequestRecapMessage } from "../../src/modules/song_requests/domain/recap";
import { sendSongRequestStreamRecap } from "../../src/modules/song_requests/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "recap-channel-fictional";
const STREAM_ID = "stream-recap-fictional";
const NOW = "2026-11-18T12:00:00.000Z";
const databases: TestD1Database[] = [];

const createContext = async () => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(CHANNEL_ID).run();
  const sendChat = vi.fn<NonNullable<ModuleExecutionContext["sendChat"]>>(() => Promise.resolve({
    sent: true, delivery: "sent", reason: null,
  }));
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    channelLanguage: () => Promise.resolve("en"),
    sendChat,
  } as unknown as ModuleExecutionContext;
  return { database, context, sendChat };
};

const insertPlayedRequest = async (
  database: TestD1Database,
  id: string,
  observedAt: string,
  requester: { id: string; login: string; displayName: string } | null,
): Promise<void> => {
  await database.prepare(`INSERT INTO song_requests
    (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, spotify_url,
     requester_user_id, requester_login, requester_display_name, state, operation_id, stream_id, round_id,
     request_type, submitted_at, observed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 1000, 0, ?, ?, ?, ?, 'observed_playing', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, CHANNEL_ID, requester === null ? "mod_vote" : "points", `track-${id}`, `spotify:track:track-${id}`,
      `Track ${id}`, `https://open.spotify.com/track/track-${id}`, requester?.id ?? null, requester?.login ?? null,
      requester?.displayName ?? null, `operation-${id}`, STREAM_ID, STREAM_ID,
      requester === null ? "vote" : "free", observedAt, observedAt, observedAt, observedAt).run();
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("song request stream recap", () => {
  it("formats a count and thanks no more than three display names", () => {
    expect(songRequestRecapMessage(songRequestChatTexts.en, 6, ["Aurora", "Birch", "Cedar", "Dune"]))
      .toBe("6 song requests played this stream. Thanks Aurora, Birch, Cedar!");
    expect(songRequestRecapMessage(songRequestChatTexts.de, 0, [])).toBe("0 Song-Wünsche wurden in diesem Stream gespielt.");
  });

  it("sends the played count, up to three requester names, and a stream idempotency key", async () => {
    const { database, context, sendChat } = await createContext();
    await insertPlayedRequest(database, "one", "2026-11-18T10:00:00.000Z", { id: "viewer-one", login: "aurora", displayName: "Aurora" });
    await insertPlayedRequest(database, "two", "2026-11-18T10:01:00.000Z", { id: "viewer-two", login: "birch", displayName: "Birch" });
    await insertPlayedRequest(database, "three", "2026-11-18T10:02:00.000Z", { id: "viewer-three", login: "cedar", displayName: "Cedar" });
    await insertPlayedRequest(database, "four", "2026-11-18T10:03:00.000Z", { id: "viewer-four", login: "dune", displayName: "Dune" });
    await insertPlayedRequest(database, "five", "2026-11-18T10:04:00.000Z", null);
    const settings = songRequestsSettingsSchema.parse({ recap: { chatEnabled: true } });

    await sendSongRequestStreamRecap(context, CHANNEL_ID, STREAM_ID, settings);
    await sendSongRequestStreamRecap(context, CHANNEL_ID, STREAM_ID, settings);

    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[0]).toEqual([
      "5 song requests played this stream. Thanks Aurora, Birch, Cedar!",
      `song-request-recap:${CHANNEL_ID}:${STREAM_ID}`,
    ]);
    expect(sendChat.mock.calls[1]?.[1]).toBe(sendChat.mock.calls[0]?.[1]);
  });

  it("does not send an empty recap or send when recap chat is disabled", async () => {
    const { database, context, sendChat } = await createContext();
    await sendSongRequestStreamRecap(context, CHANNEL_ID, STREAM_ID, songRequestsSettingsSchema.parse({}));
    await insertPlayedRequest(database, "one", NOW, { id: "viewer-one", login: "aurora", displayName: "Aurora" });
    await sendSongRequestStreamRecap(context, CHANNEL_ID, STREAM_ID,
      songRequestsSettingsSchema.parse({ recap: { chatEnabled: false } }));
    expect(sendChat).not.toHaveBeenCalled();
  });
});
