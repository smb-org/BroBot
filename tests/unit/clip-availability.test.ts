import { describe, expect, it, vi } from "vitest";

import { createClip } from "../../src/worker/clip";

describe("clip availability confirmation", () => {
  it("does not report a clip when Twitch never lists it within the confirmation window", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>((_input, init) => Promise.resolve(init?.method === "POST"
      ? new Response(JSON.stringify({ data: [{ id: "clip-pending", edit_url: "https://clips.twitch.tv/clip-pending/edit" }] }), { status: 202 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 })));

    const result = await createClip(
      { TWITCH_CLIENT_ID: "client-id" },
      "access-token",
      "broadcaster-id",
      fetcher,
      {
        timeoutMs: 15_000,
        pollIntervalMs: 2_000,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(result).toMatchObject({ created: false, reason: "availability_timeout", clipId: null, editUrl: null });
    expect(now).toBe(15_000);
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("does not confirm a clip returned after the availability deadline", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "POST") {
        return Promise.resolve(new Response(
          JSON.stringify({ data: [{ id: "clip-late", edit_url: "https://clips.twitch.tv/clip-late/edit" }] }),
          { status: 202 },
        ));
      }
      now = 15_001;
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "clip-late" }] }), { status: 200 }));
    });

    const result = await createClip(
      { TWITCH_CLIENT_ID: "client-id" },
      "access-token",
      "broadcaster-id",
      fetcher,
      { timeoutMs: 15_000, now: () => now },
    );

    expect(result).toMatchObject({ created: false, reason: "availability_timeout", clipId: null, editUrl: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("includes response body reading in the availability confirmation deadline", async () => {
    const delayedBody = new Response(null, { status: 200 });
    delayedBody.json = () => new Promise<never>(() => undefined);
    const fetcher = vi.fn<typeof fetch>((_input, init) => Promise.resolve(init?.method === "POST"
      ? new Response(JSON.stringify({ data: [{ id: "clip-stalled", edit_url: "https://clips.twitch.tv/clip-stalled/edit" }] }), { status: 202 })
      : delayedBody));

    const result = await Promise.race([
      createClip(
        { TWITCH_CLIENT_ID: "client-id" },
        "access-token",
        "broadcaster-id",
        fetcher,
        { timeoutMs: 20, pollIntervalMs: 5 },
      ),
      new Promise<null>((resolve) => { setTimeout(() => { resolve(null); }, 250); }),
    ]);

    expect(result).toMatchObject({ created: false, reason: "availability_timeout", clipId: null, editUrl: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
