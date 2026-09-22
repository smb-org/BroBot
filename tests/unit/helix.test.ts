import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { helixPages, helixRequest } from "../../src/worker/twitch/helix";
import type { HelixResult } from "../../src/modules/contract";

describe("helixRequest", () => {
  it("sends Client-ID and bearer headers, and encodes the query", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await helixRequest({
      url: "https://api.twitch.tv/helix/users",
      query: { login: "brobot" },
      accessToken: "app-token",
      clientId: "client-id",
      fetcher,
    });

    expect(result).toMatchObject({ ok: true, status: 200, data: { data: [] } });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/users?login=brobot",
      expect.objectContaining({
        headers: { "Client-ID": "client-id", Authorization: "Bearer app-token" },
      }),
    );
  });

  it("JSON-encodes a body and adds Content-Type only when there is one", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await helixRequest({
      method: "POST",
      url: "https://api.twitch.tv/helix/channels/commercial",
      body: { broadcaster_id: "kanal-a", length: 90 },
      accessToken: "app-token",
      clientId: "client-id",
      fetcher,
    });

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown).toEqual({
      broadcaster_id: "kanal-a",
      length: 90,
    });
  });

  it("reports a hung request as timeout, distinct from a network error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(new Promise<Response>(() => undefined));
    vi.useFakeTimers();
    try {
      const pending = helixRequest({
        url: "https://api.twitch.tv/helix/users",
        accessToken: "app-token",
        clientId: "client-id",
        fetcher,
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: "timeout", status: null });
    } finally {
      vi.useRealTimers();
    }

    const networkFetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("no network"));
    await expect(helixRequest({
      url: "https://api.twitch.tv/helix/users",
      accessToken: "app-token",
      clientId: "client-id",
      fetcher: networkFetcher,
    })).resolves.toMatchObject({ ok: false, reason: "network_error", status: null });
  });

  it("classifies a 429 as rate_limited without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "slow down" }),
      { status: 429 },
    ));

    const result = await helixRequest({
      url: "https://api.twitch.tv/helix/users",
      accessToken: "app-token",
      clientId: "client-id",
      fetcher,
    });

    expect(result).toMatchObject({ ok: false, reason: "rate_limited", status: 429, message: "slow down" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a schema mismatch as invalid_response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json", { status: 200 }));

    const result = await helixRequest({
      url: "https://api.twitch.tv/helix/users",
      accessToken: "app-token",
      clientId: "client-id",
      fetcher,
      schema: z.object({ data: z.array(z.unknown()) }),
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_response" });
  });
});

describe("helixPages", () => {
  it("collects every page and follows the cursor", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [1], pagination: { cursor: "seite-2" } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [2], pagination: {} } });

    await expect(helixPages(fetchPage)).resolves.toEqual({ ok: true, status: 200, data: [1, 2] });
    expect(fetchPage).toHaveBeenNthCalledWith(1, null);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "seite-2");
  });

  it("stops on a repeated cursor instead of looping forever", async () => {
    const fetchPage = vi.fn<() => Promise<HelixResult<{ data: unknown[]; pagination?: { cursor?: string } }>>>()
      .mockImplementation(() => Promise.resolve({ ok: true, status: 200, data: { data: [], pagination: { cursor: "immer" } } }));

    await expect(helixPages(fetchPage)).resolves.toMatchObject({ ok: false, reason: "pagination_loop" });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("passes a failed page straight through", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      ok: false, status: 429, reason: "rate_limited", message: null, body: {},
    });

    await expect(helixPages(fetchPage)).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
  });
});
