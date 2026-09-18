import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAuditLog,
  fetchChannelOverview,
  PanelApiError,
  requestJson,
} from "../../src/dashboard/api";

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

describe("Dashboard-API-Requestgrenze", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("weist eine absolute URL auf eine fremde Origin zurück, ohne fetch aufzurufen", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("https://fremde.example/api/channels")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("weist eine protokollrelative URL zurück, ohne fetch aufzurufen", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("//fremde.example/api/channels")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("weist einen Pfad zurück, der über .. aus dem erlaubten Bereich führt", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("/api/channels/kanal-a/../../csrf")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("behält Sonderzeichen in Kanal-IDs und Audit-Cursor bei regulären Aufrufen bei", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ channelId: "kanal/sonder?#" }))
      .mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    await fetchChannelOverview("kanal/sonder?#");
    await fetchAuditLog("kanal/sonder?#", "cursor /?#&");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("/api/channels/kanal%2Fsonder%3F%23/overview", window.location.origin),
      { credentials: "same-origin" },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL(
        "/api/channels/kanal%2Fsonder%3F%23/audit-log?cursor=cursor+%2F%3F%23%26",
        window.location.origin,
      ),
      { credentials: "same-origin" },
    );
  });
});
