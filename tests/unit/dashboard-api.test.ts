import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "./fixtures";

import {
  addChannelMember,
  fetchAuditLog,
  fetchChannelOverview,
  fetchEvents,
  fetchMembers,
  removeChannelMember,
  refreshModeratorStatus,
  searchTwitchUser,
  updateChannelMemberRole,
  PanelApiError,
  requestJson,
} from "../../src/dashboard/api";

describe("dashboard API request boundary", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an absolute URL to a foreign origin without calling fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("https://fremde.example/api/channels")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a protocol-relative URL without calling fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("//fremde.example/api/channels")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a path that escapes the allowed area via ..", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(requestJson("/api/channels/kanal-a/../../csrf")).rejects.toBeInstanceOf(PanelApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves special characters in channel IDs and audit cursors on regular calls", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ channelId: "kanal/sonder?#" }))
      .mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    await fetchChannelOverview("kanal/sonder?#");
    await fetchAuditLog("kanal/sonder?#", "cursor /?#&");
    await fetchEvents("kanal/sonder?#", "cursor /?#&");

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
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      new URL(
        "/api/channels/kanal%2Fsonder%3F%23/events?cursor=cursor+%2F%3F%23%26",
        window.location.origin,
      ),
      { credentials: "same-origin" },
    );
  });

  it("loads members and looks up a Twitch user, scoped to the channel", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ members: [] }))
      .mockResolvedValueOnce(jsonResponse({ user: { userId: "123", login: "neue-person", displayName: "Neue Person" } }));
    vi.stubGlobal("fetch", fetcher);

    await fetchMembers("kanal-a");
    await searchTwitchUser("kanal-a", "neue-person");

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      new URL("/api/channels/kanal-a/members", window.location.origin),
      { credentials: "same-origin" },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("/api/channels/kanal-a/members/search?login=neue-person", window.location.origin),
      { credentials: "same-origin" },
    );
  });

  it("forwards the member cursor and the abort signal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ members: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    await fetchMembers("kanal-a", "cursor /?#&", controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/channels/kanal-a/members?cursor=cursor+%2F%3F%23%26", window.location.origin),
      { credentials: "same-origin", signal: controller.signal },
    );
  });

  it("forwards all event filters together with the cursor and the abort signal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    const fetchEventsWithFilters = fetchEvents as unknown as (
      channelId: string,
      cursor: string | null,
      signal: AbortSignal,
      filters: { origin: "channel" | "module" | null; module: string | null; tone: "info" | "warning" | "error" | null; person: string | null },
    ) => Promise<unknown>;
    await fetchEventsWithFilters("kanal-a", "cursor /?#&", controller.signal, {
      origin: "module",
      module: "text_commands",
      tone: "error",
      person: "person /?#&",
    });

    expect(fetcher).toHaveBeenCalledWith(
      new URL(
        "/api/channels/kanal-a/events?cursor=cursor+%2F%3F%23%26&origin=module&module=text_commands&tone=error&actor=person+%2F%3F%23%26",
        window.location.origin,
      ),
      { credentials: "same-origin", signal: controller.signal },
    );
  });

  it("fetches CSRF before every member change and sends the matching mutation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({ member: { userId: "123", role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" } }, 201))
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token-2" }))
      .mockResolvedValueOnce(jsonResponse({ member: { userId: "123", role: "manager", joinedAt: "2026-09-18T00:00:00.000Z" } }))
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token-3" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await addChannelMember("kanal-a", "123", "operator");
    await updateChannelMemberRole("kanal-a", "123", "manager");
    await removeChannelMember("kanal-a", "123");

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("/api/channels/kanal-a/members", window.location.origin),
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-token" },
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      new URL("/api/channels/kanal-a/members/123", window.location.origin),
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-token-2" },
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      new URL("/api/channels/kanal-a/members/123", window.location.origin),
      expect.objectContaining({
        method: "DELETE",
        headers: { "X-CSRF-Token": "csrf-token-3" },
      }),
    );
  });

  it("fetches CSRF before the moderator status check and sends only the target channel", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "csrf-token" }))
      .mockResolvedValueOnce(jsonResponse({
        moderator: { isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null },
        nextAllowedAt: "2026-09-18T04:05:00.000Z",
      }));
    vi.stubGlobal("fetch", fetcher);

    await refreshModeratorStatus("kanal/sonder?#");

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      new URL("/api/channels/kanal%2Fsonder%3F%23/moderator-status", window.location.origin),
      expect.objectContaining({
        method: "POST",
        headers: { "X-CSRF-Token": "csrf-token" },
      }),
    );
  });
});
