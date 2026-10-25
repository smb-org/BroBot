import { describe, expect, it, vi } from "vitest";

import { postConfirmedClipLink } from "../../src/worker/clip";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("confirmed clip timeline", () => {
  it("stores only the confirmed clip id and ignores retries for the same clip", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "channel-a");
      const environment = {
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
      };
      const confirmed = {
        created: true,
        reason: null,
        detail: { status: 200, confirmationStatus: 200 },
        clipId: "clip-1",
        editUrl: "https://clips.twitch.tv/clip-1/edit",
        title: "A good moment",
        url: "https://clips.twitch.tv/clip-1",
      };

      await postConfirmedClipLink(environment, "channel-a", null, {
        postClipLinkInChat: false,
        chatLinkTemplate: "Clip: {clip.url}",
      }, confirmed, vi.fn<typeof fetch>(), "trigger-1");
      await postConfirmedClipLink(environment, "channel-a", null, {
        postClipLinkInChat: false,
        chatLinkTemplate: "Clip: {clip.url}",
      }, confirmed, vi.fn<typeof fetch>(), "trigger-1");

      const rows = await database.prepare(
        `SELECT kind, detail_json FROM channel_timeline_events WHERE channel_id = ?`,
      ).bind("channel-a").all<{ kind: string; detail_json: string }>();
      expect(rows.results).toEqual([{ kind: "clip_created", detail_json: JSON.stringify({ clipId: "clip-1" }) }]);
    } finally {
      database.close();
    }
  });
});
