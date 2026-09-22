import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
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

  it("lädt Mitglieder und sucht einen Twitch-Nutzer kanalgebunden", async () => {
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

  it("überträgt Mitglieder-Cursor und Abbruchsignal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ members: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    await fetchMembers("kanal-a", "cursor /?#&", controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/channels/kanal-a/members?cursor=cursor+%2F%3F%23%26", window.location.origin),
      { credentials: "same-origin", signal: controller.signal },
    );
  });

  it("überträgt alle Ereignisfilter zusammen mit Cursor und Abbruchsignal", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ entries: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetcher);

    const fetchEventsWithFilters = fetchEvents as unknown as (
      channelId: string,
      cursor: string | null,
      signal: AbortSignal,
      filters: { herkunft: "kanal" | "modul" | null; modul: string | null; ton: "info" | "warning" | "error" | null; person: string | null },
    ) => Promise<unknown>;
    await fetchEventsWithFilters("kanal-a", "cursor /?#&", controller.signal, {
      herkunft: "modul",
      modul: "text_commands",
      ton: "error",
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

  it("holt vor jeder Mitgliederänderung CSRF und sendet die passende Mutation", async () => {
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

  it("holt vor der Moderatorstatus-Prüfung CSRF und sendet nur den Zielkanal", async () => {
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
