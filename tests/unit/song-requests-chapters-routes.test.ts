import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { songRequestsRoutes } from "../../src/modules/song_requests/routes";
import { saveSongRequestChapter } from "../../src/modules/song_requests/repository";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "chapter-route-channel-fictional";
const databaseList: TestD1Database[] = [];

afterEach(() => { for (const database of databaseList.splice(0)) database.close(); });

describe("song request chapter vote route", () => {
  it("returns a localized 409 when fewer than two chapter tracks are eligible", async () => {
    const database = new TestD1Database();
    databaseList.push(database);
    await insertChannel(database, CHANNEL_ID);
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'song_requests', 1, '{}')")
      .bind(CHANNEL_ID).run();
    await database.prepare("INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at) VALUES (1, ?, ?, ?)")
      .bind(CHANNEL_ID, "moderator-fictional", "2026-11-18T10:00:00.000Z").run();
    await database.prepare(`INSERT INTO channel_stream_state
      (channel_id, state, changed_at, source, stream_id, started_at)
      VALUES (?, 'online', ?, 'eventsub', ?, ?)`)
      .bind(CHANNEL_ID, "2026-11-18T10:00:00.000Z", "stream-chapter-fictional", "2026-11-18T10:00:00.000Z").run();
    const saved = await saveSongRequestChapter(database as unknown as D1Database, CHANNEL_ID, null, null, {
      name: "Night Drive",
      offerInCockpit: true,
      tracks: [{ id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: null }],
    }, "2026-11-18T10:00:00.000Z");
    if (saved.status !== "saved") throw new Error("Expected a saved chapter fixture.");
    const app = new Hono<ModuleRouteEnvironment>();
    app.use("*", async (context, next) => { context.set("channelRole", "operator"); await next(); });
    app.route("/channels/:channelId", songRequestsRoutes);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId: saved.chapter.id }),
    }), { DB: database as unknown as D1Database });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "song_vote_chapter_not_enough_tracks",
      message: {
        de: "Dieses Kapitel hat weniger als zwei verfügbare Songs. Ergänze Tracks oder prüfe die Abklingzeit.",
        en: "This chapter has fewer than two eligible tracks. Add tracks or check the cooldown.",
      },
    });
  });
});
