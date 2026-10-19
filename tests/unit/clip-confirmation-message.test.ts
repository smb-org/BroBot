import { describe, expect, it, vi } from "vitest";

import { createClip } from "../../src/worker/clip";

describe("confirmed clip link data", () => {
  it("returns the public title and URL only after Twitch confirms availability", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "clip-a", edit_url: "https://clips.twitch.tv/clip-a/edit" }],
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "clip-a", title: "A good moment", url: "https://clips.twitch.tv/clip-a" }],
      }), { status: 200 }));

    const result = await createClip(
      { TWITCH_CLIENT_ID: "client-id" },
      "bot-token",
      "channel-a",
      fetcher,
      { now: () => 0, timeoutMs: 1_000, sleep: () => Promise.resolve() },
    );

    expect(result).toMatchObject({
      created: true,
      clipId: "clip-a",
      title: "A good moment",
      url: "https://clips.twitch.tv/clip-a",
    });
  });
});
