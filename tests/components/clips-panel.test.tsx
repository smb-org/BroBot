import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import ClipsPanel from "../../src/modules/clips/panel";
import type { ClipsSettings, SessionClipList } from "../../src/modules/clips/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const settings: ClipsSettings = {
  commandMinimumRole: "vip",
  commandCooldownSeconds: 180,
  postClipLinkInChat: true,
  chatLinkTemplate: "Clip aus dem Stream: {clip.title} {clip.url}",
  automaticClipsEnabled: true,
  automaticThresholdMultiplier: 3.5,
  automaticCooldownSeconds: 1200,
};

const channelId = "kanal-a";
const settingsUrl = `/api/channels/${channelId}/modules/clips/settings`;
const clipsUrl = `/api/channels/${channelId}/clips`;

const requestPath = (input: RequestInfo | URL): string => new URL(
  input instanceof Request ? input.url : String(input),
  window.location.origin,
).pathname;

const baseFetch = vi.fn<typeof fetch>((input) => {
  const path = requestPath(input);
  if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings, revision: 1 }));
  if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
  return Promise.resolve(jsonResponse({}));
});

const renderPanel = (fetcher: typeof fetch = baseFetch, streamSessionIdentity?: string) => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(
    <UiProvider><ClipsPanel channelId={channelId} language="de" {...(streamSessionIdentity === undefined ? {} : { streamSessionIdentity })} /></UiProvider>,
  );
};

describe("clips panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows stored settings in visible disabled controls with no save or restore path", async () => {
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Chatbefehl !clip", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clip-Link im Chat posten", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Automatische Clip-Einstellungen", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("Kommt in einer späteren Version.", { exact: true })).toHaveLength(3);

    for (const id of ["clips-command-role", "clips-command-cooldown", "clips-chat-message", "clips-auto-threshold", "clips-auto-cooldown"]) {
      expect(document.getElementById(id)).toBeDisabled();
    }
    expect(screen.getByRole("switch", { name: "Aktiviert" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Automatische Clips" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Mindestrolle" })).toBeDisabled();
    expect(document.getElementById("clips-command-cooldown")).toHaveValue(180);
    expect(document.getElementById("clips-chat-message")).toHaveValue(settings.chatLinkTemplate);
    expect(document.getElementById("clips-auto-threshold")).toHaveValue(3.5);
    expect(document.getElementById("clips-auto-cooldown")).toHaveValue(1200);
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Weitere Aktionen" })).not.toBeInTheDocument();
  });

  it("clears a settings refresh error after the query recovers", async () => {
    let failSettings = false;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === settingsUrl) {
        return Promise.resolve(failSettings
          ? jsonResponse({ error: "settings_unavailable" }, 503)
          : jsonResponse({ settings, revision: 1 }));
      }
      if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
      return Promise.resolve(jsonResponse({}));
    });
    const { queryClient } = renderPanel(fetcher);
    expect(await screen.findByRole("heading", { name: "Clip-Einstellungen", level: 2 })).toBeInTheDocument();
    const queryKey = moduleQueryKey(channelId, "clips", "clips-settings");

    failSettings = true;
    await queryClient.invalidateQueries({ queryKey, exact: true });
    expect(await screen.findByText("Die Clip-Einstellungen konnten nicht geladen werden.", { selector: '[role="alert"]' })).toBeInTheDocument();

    failSettings = false;
    await queryClient.invalidateQueries({ queryKey, exact: true });
    await waitFor(() => expect(screen.queryByText("Die Clip-Einstellungen konnten nicht geladen werden.", { selector: '[role="alert"]' })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Clip-Einstellungen", level: 2 })).toBeInTheDocument();
  });

  it("refetches clips when the stream changes offline and starts a new session", async () => {
    let clipResponse: SessionClipList = {
      streamStartedAt: "2026-10-16T08:00:00.000Z",
      clips: [{ clipId: "session-one", createdAt: "2026-10-16T08:01:00.000Z" }],
    };
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings, revision: 1 }));
      if (path === clipsUrl) return Promise.resolve(jsonResponse(clipResponse));
      return Promise.resolve(jsonResponse({}));
    });
    const view = renderPanel(fetcher, "online:session-one");
    expect(await screen.findByText("Clip session-one")).toBeInTheDocument();

    clipResponse = { streamStartedAt: null, clips: [] };
    view.rerender(<UiProvider><ClipsPanel channelId={channelId} language="de" streamSessionIdentity="offline" /></UiProvider>);
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => requestPath(input) === clipsUrl)).toHaveLength(2));
    expect(await screen.findByText("Die Liste zeigt Clips, sobald der Stream live ist.")).toBeInTheDocument();
    expect(screen.queryByText("Clip session-one")).not.toBeInTheDocument();

    clipResponse = {
      streamStartedAt: "2026-10-16T09:00:00.000Z",
      clips: [{ clipId: "session-two", createdAt: "2026-10-16T09:01:00.000Z" }],
    };
    view.rerender(<UiProvider><ClipsPanel channelId={channelId} language="de" streamSessionIdentity="online:session-two" /></UiProvider>);
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => requestPath(input) === clipsUrl)).toHaveLength(3));
    expect(await screen.findByText("Clip session-two")).toBeInTheDocument();
  });

  it("keeps clip refresh errors in the list header and clears them on retry", async () => {
    let failRefresh = false;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = requestPath(input);
      if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings, revision: 1 }));
      if (path === clipsUrl) {
        return Promise.resolve(failRefresh
          ? jsonResponse({ error: "clips_unavailable" }, 503)
          : jsonResponse({ streamStartedAt: "2026-10-16T08:00:00.000Z", clips: [{ clipId: "clip-a", createdAt: "2026-10-16T08:01:00.000Z" }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    renderPanel(fetcher);
    expect(await screen.findByText("Clip clip-a")).toBeInTheDocument();

    failRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Clips aktualisieren" }));

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Die Clips dieser Sitzung konnten nicht geladen werden.");
    expect(error).toHaveTextContent("Erneut versuchen");
    expect(error.closest(".ui-section__heading")).not.toBeNull();
    expect(screen.getByText("Clip clip-a")).toBeInTheDocument();

    failRefresh = false;
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("Clip clip-a")).toBeInTheDocument();
  });
});
