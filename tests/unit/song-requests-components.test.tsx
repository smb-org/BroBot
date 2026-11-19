import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { moduleQueryKey, useDashboardQueryClient } from "../../src/dashboard/data";
import { refetchModuleQueryData } from "../../src/dashboard/data/module-query";
import { reconcileDashboardPanelResourceRevisions } from "../../src/dashboard/data/realtime";
import SongRequestsPanel from "../../src/modules/song_requests/panel";
import { songRequestsPanelTexts } from "../../src/modules/song_requests/panel/locale";
import SongRequestsNowPlaying from "../../src/modules/song_requests/overlay/view";
import SongRequestsNowPlayingEditor from "../../src/modules/song_requests/overlay/editor";
import { songRequestsSettingsSchema } from "../../src/modules/song_requests/contracts";

const track = { id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: "https://i.scdn.co/image/fictional-cover", spotifyUrl: "https://open.spotify.com/track/glassharbor01" };
const urlOf = (input: RequestInfo | URL): URL => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const requestsRead = (
  requests: unknown[] = [],
  nowPlaying: unknown = null,
  voteOutcomes: unknown[] = [],
  filter: "open" | "played" | "all" = "open",
  page = 1,
  total = requests.length,
) => ({ requests, total, filter, page, pageSize: 20, voteOutcomes, nowPlaying });
const settings = (emptyText = "") => songRequestsSettingsSchema.parse({ emptyText });
const QueryClientCapture = ({ onCapture, children }: { onCapture: (client: QueryClient) => void; children: ReactNode }) => {
  onCapture(useDashboardQueryClient());
  return <>{children}</>;
};
const renderPanel = (): void => {
  render(<DashboardDataProvider><SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate /></DashboardDataProvider>);
};

describe("song request components", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a fixed now-playing card with Spotify attribution and vote label", () => {
    const { container } = render(<SongRequestsNowPlaying
      config={{ showCover: true, showRequester: true }}
      state={{ revision: 1, serverNow: "2026-11-15T12:00:00.000Z", track: { ...track, artist: "Mira Vale", requester: null, source: "mod_vote", durationMs: 296_000, progressMs: 83_000 } }}
      now={Date.parse("2026-11-15T12:00:00.000Z")}
      language="en"
    />);
    expect(screen.getByRole("link", { name: "Glass Harbor" })).toHaveAttribute("href", track.spotifyUrl);
    expect(container.querySelector(".song-requests-now-playing__spotify")).toHaveTextContent("Spotify");
    expect(container.querySelector(".song-requests-now-playing__requester")).toHaveTextContent("Song vote");
    expect(container.querySelector(".song-requests-now-playing")).toHaveStyle({ width: "640px", height: "112px" });
    expect(container.querySelector(".song-requests-now-playing__progress")).toBeInTheDocument();
    expect(container.querySelector(".song-requests-now-playing__progress")).toHaveTextContent("1:23 / 4:56");
  });

  it("omits the progress row when progress is disabled", () => {
    const { container } = render(<SongRequestsNowPlaying
      config={{ showCover: true, showRequester: true, showProgress: false }}
      state={{ revision: 2, serverNow: "2026-11-15T12:00:00.000Z", track: { ...track, artist: "Mira Vale", requester: null, source: "mod_vote" } }}
      now={Date.parse("2026-11-15T12:00:00.000Z")}
      language="en"
    />);
    expect(container.querySelector(".song-requests-now-playing__progress")).not.toBeInTheDocument();
  });

  it("keeps the idle element reserved and renders its configured empty text", () => {
    const { container } = render(<SongRequestsNowPlaying
      config={{ showCover: false, showRequester: true }}
      state={{ revision: 0, serverNow: "2026-11-15T12:00:00.000Z", track: null, emptyText: "Pick a song" }}
      now={Date.parse("2026-11-15T12:00:00.000Z")}
      language="en"
    />);
    expect(container.querySelector(".song-requests-now-playing")).toHaveStyle({ width: "640px", height: "112px" });
    expect(container.querySelector(".song-requests-now-playing__copy h2")).toHaveTextContent("Pick a song");
    expect(container.querySelector(".song-requests-now-playing__spotify")?.textContent.trim()).toBe("");
  });

  it("keeps an unconfigured idle overlay invisible while reserving its size", () => {
    const { container } = render(<SongRequestsNowPlaying
      config={{ showCover: true, showRequester: true }}
      state={{ revision: 0, serverNow: "2026-11-15T12:00:00.000Z", track: null, emptyText: "" }}
      now={Date.parse("2026-11-15T12:00:00.000Z")}
      language="en"
    />);
    const overlay = container.querySelector(".song-requests-now-playing");
    expect(overlay).toHaveStyle({ width: "640px", height: "112px", visibility: "hidden" });
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  it("labels the overlay editor controls and emits its fictional preview", () => {
    const onChange = vi.fn();
    const onPreviewState = vi.fn();
    render(<SongRequestsNowPlayingEditor config={{}} onChange={onChange} onPreviewState={onPreviewState} language="en" />);
    fireEvent.click(screen.getByRole("switch", { name: "Show cover" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showCover: false, showRequester: true }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreviewState).toHaveBeenCalledTimes(1);
    expect(onPreviewState.mock.calls[0]).toMatchObject([{ track: { title: "Glass Harbor", artist: "Mira Vale" } }]);
  });

  it.each<{ state: string; enabled: boolean; message: string; errorMessage?: string }>([
    { state: "not_enabled", enabled: false, message: "Spotify is not enabled for this channel." },
    { state: "not_connected", enabled: true, message: "Spotify is not connected yet." },
    { state: "connected", enabled: true, message: "Spotify is connected." },
    { state: "spotify_error", enabled: true, errorMessage: "Insufficient Spotify scope", message: "Insufficient Spotify scope" },
    { state: "premium_required", enabled: true, message: "The connected account needs Spotify Premium for playback." },
    { state: "no_active_device", enabled: true, message: "Spotify found no active playback device. Start Spotify on a device." },
    { state: "reconnect_required", enabled: true, message: "The connection needs to be renewed." },
  ])("explains the $state connection state", async ({ state, enabled, message, errorMessage }) => {
    const hasCredentials = enabled && state !== "not_connected";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled, hasCredentials, slot: enabled ? 2 : null, state, errorMessage: errorMessage ?? null, streamId: null, emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead()));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings("Pick a song"), revision: 3 }));
      return Promise.resolve(json({}));
    }));
    renderPanel();
    await screen.findByText(message);
    if (enabled && hasCredentials) await screen.findByRole("button", { name: "Reconnect" });
    if (!enabled) {
      expect(screen.queryByRole("button", { name: "Connect Spotify" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    }
    if (!hasCredentials) expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("shows the no-results empty state only after a search returns no tracks", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead()));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings(), revision: 3 }));
      if (url.pathname.endsWith("/search")) return Promise.resolve(json({ tracks: [] }));
      return Promise.resolve(json({}));
    }));
    renderPanel();

    expect(screen.queryByText("No tracks found.")).not.toBeInTheDocument();
    fireEvent.change(await screen.findByRole("textbox", { name: "Track, Spotify link, or URI" }), { target: { value: "Silent Map" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No tracks found.")).toBeInTheDocument();
  });

  it("submits Spotify search when Enter is pressed in the query field", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead()));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings(), revision: 3 }));
      if (url.pathname.endsWith("/search")) return Promise.resolve(json({ tracks: [] }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    const field = await screen.findByRole("textbox", { name: "Track, Spotify link, or URI" });
    fireEvent.change(field, { target: { value: "Silent Map" } });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter", charCode: 13 });

    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => urlOf(input).pathname.endsWith("/search"))).toBe(true);
    });
  });

  it("leaves all settings controls to the shared settings editor", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead()));
      return Promise.resolve(json({}));
    }));
    renderPanel();
    await screen.findByText("Spotify is connected.");

    expect(screen.queryByRole("textbox", { name: "Player empty text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bot points" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("defaults to Open, switches filters, and refreshes current and previously played request states", async () => {
    const requests = [
      {
        requestId: "current-song", ...track, state: "observed_playing", failureReason: null, source: "points", requestType: "free", chargedAmount: 0,
        requesterDisplayName: "Fictional Viewer", requesterLogin: "fictional_viewer", createdAt: "2026-11-15T19:00:00.000Z",
      },
      {
        requestId: "earlier-song", ...track, id: "quietatlas02", title: "Quiet Atlas", coverUrl: null, state: "observed_playing", failureReason: null,
        source: "mod_vote", requestType: "vote", chargedAmount: 0, requesterDisplayName: null, requesterLogin: null,
        createdAt: "2026-11-15T18:00:00.000Z",
      },
    ];
    let nowPlaying: { requestId: string; playing: boolean } | null = { requestId: "current-song", playing: true };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 1, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) {
        const filter = url.searchParams.get("filter") === "all" ? "all" : "open";
        const page = Number(url.searchParams.get("page") ?? "1");
        const visibleRequests = filter === "open" ? requests.filter(({ requestId }) => requestId === "current-song") : requests;
        return Promise.resolve(json(requestsRead(visibleRequests, nowPlaying, [], filter, page)));
      }
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings(), revision: 1 }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const captured: { client: QueryClient | null } = { client: null };
    render(<DashboardDataProvider><QueryClientCapture onCapture={(client) => { captured.client = client; }}>
      <SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />
    </QueryClientCapture></DashboardDataProvider>);

    const currentLink = await screen.findByRole("link", { name: /Glass Harbor/u });
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("link", { name: /Quiet Atlas/u })).not.toBeInTheDocument();
    const currentRow = currentLink.closest('[role="listitem"]');
    expect(currentRow?.querySelector(".list-row__title")).toHaveTextContent("Glass Harbor");
    expect(currentRow?.querySelector(".list-row__description")).toHaveTextContent("Mira Vale · Fictional Viewer");
    expect(currentRow?.querySelector(".song-requests-cover")).toHaveAttribute("src", track.coverUrl);
    expect(currentRow?.querySelector(".list-row__status")).toHaveTextContent("Now playing");
    expect(currentRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--green");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const earlierLink = await screen.findByRole("link", { name: /Quiet Atlas/u });
    const earlierRow = earlierLink.closest('[role="listitem"]');
    expect(earlierRow?.querySelector(".list-row__title")).toHaveTextContent("Quiet Atlas");
    expect(earlierRow?.querySelector(".list-row__description")).toHaveTextContent("Mira Vale · Song vote");
    expect(earlierRow?.querySelector(".song-requests-cover")).toBeNull();
    expect(earlierRow?.querySelector(".list-row__icon svg")).toBeInTheDocument();
    expect(earlierRow?.querySelector(".list-row__status")).toHaveTextContent("Played");
    expect(earlierRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--neutral");

    if (captured.client === null) throw new Error("The dashboard query client was not captured.");
    nowPlaying = { requestId: "current-song", playing: false };
    await refetchModuleQueryData(captured.client, "channel-fictional", "song_requests", "requests:all:1");
    await waitFor(() => {
      expect(currentRow?.querySelector(".list-row__status")).toHaveTextContent("Paused");
      expect(currentRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--neutral");
      expect(earlierRow?.querySelector(".list-row__status")).toHaveTextContent("Played");
    });
    expect(songRequestsPanelTexts.de.states.paused).toBe("Pausiert");

    nowPlaying = { requestId: "current-song", playing: true };
    await refetchModuleQueryData(captured.client, "channel-fictional", "song_requests", "requests:all:1");
    await waitFor(() => {
      expect(currentRow?.querySelector(".list-row__status")).toHaveTextContent("Now playing");
      expect(currentRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--green");
    });

    nowPlaying = { requestId: "earlier-song", playing: true };
    await refetchModuleQueryData(captured.client, "channel-fictional", "song_requests", "requests:all:1");
    await waitFor(() => {
      expect(currentRow?.querySelector(".list-row__status")).toHaveTextContent("Played");
      expect(currentRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--neutral");
      expect(earlierRow?.querySelector(".list-row__status")).toHaveTextContent("Now playing");
      expect(earlierRow?.querySelector(".ui-badge")).toHaveClass("ui-badge--green");
    });
  });

  it("shows Spotify state and starts a vote from a deterministic three-track search", async () => {
    const searchTracks = [
      { ...track, id: "glassharbor01", spotifyUrl: "https://open.spotify.com/track/glassharbor01" },
      { ...track, id: "quietatlas02", title: "Quiet Atlas", spotifyUrl: "https://open.spotify.com/track/quietatlas02" },
      { ...track, id: "silvercurrent03", title: "Silver Current", spotifyUrl: "https://open.spotify.com/track/silvercurrent03" },
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-e2e" }));
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 3, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead([], null, [
        { ballotId: "ballot-drawn", state: "drawn", drawnByLot: true, createdAt: "2026-11-15T19:00:00.000Z" },
        { ballotId: "ballot-tie", state: "tie", drawnByLot: false, createdAt: "2026-11-15T18:00:00.000Z" },
      ])));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings("Pick a song"), revision: 3 }));
      if (url.pathname.endsWith("/search")) return Promise.resolve(json({ tracks: searchTracks }));
      if (url.pathname.endsWith("/vote")) return Promise.resolve(json({ ballotId: "ballot-fictional" }, 201));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    await screen.findByText("Spotify is connected.");
    await screen.findByText("Tie · nothing queued");
    await screen.findByText("Tie · drawn by lot");
    fireEvent.change(screen.getByRole("textbox", { name: "Track, Spotify link, or URI" }), { target: { value: "Glass Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Mira Vale – Silver Current");
    for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
      fireEvent.click(screen.getByRole("button", { name: `Add ${title} to vote` }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => { expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/vote"), expect.objectContaining({ method: "POST" })); });
    const voteCall = fetcher.mock.calls.find(([input]) => urlOf(input).pathname.endsWith("/vote"));
    const body = voteCall?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "{}")).toEqual({ trackIds: ["glassharbor01", "quietatlas02", "silvercurrent03"] });
  });

  it("keeps the selected filter and page on refetch and clamps clear-list results using fresh page-one data", async () => {
    const makeRows = (prefix: string, state: string) => Array.from({ length: 21 }, (_, index) => ({
      requestId: `${prefix}-${String(index).padStart(2, "0")}`,
      ...track,
      title: `${prefix} Track ${String(index).padStart(2, "0")}`,
      state,
      failureReason: null,
      source: "points",
      requestType: "free",
      chargedAmount: 0,
      requesterDisplayName: "Fictional Viewer",
      requesterLogin: "fictional_viewer",
      createdAt: `2026-11-15T19:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const openRows = makeRows("Open", "pending_review");
    const playedRows = makeRows("Played", "not_observed");
    let total = 21;
    const requestCalls: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-clear" }));
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 1, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/revisions")) return Promise.resolve(json({ revisions: { "module:song_requests:requests": 0 } }));
      if (url.pathname.endsWith("/clear")) {
        total = 0;
        return Promise.resolve(json({ cleared: true }));
      }
      if (url.pathname.endsWith("/requests")) {
        requestCalls.push(url.search);
        const filter = url.searchParams.get("filter") === "played" ? "played" : "open";
        const page = Number(url.searchParams.get("page") ?? "1");
        const rows = total === 0 ? [] : filter === "played" ? playedRows : openRows;
        return Promise.resolve(json(requestsRead(rows.slice((page - 1) * 20, page * 20), null, [], filter, page, total)));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const captured: { client: QueryClient | null } = { client: null };
    render(<DashboardDataProvider><QueryClientCapture onCapture={(client) => { captured.client = client; }}>
      <SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />
    </QueryClientCapture></DashboardDataProvider>);

    const countFooter = (): Element | null => document.querySelector(".list-pagination-footer__count");
    await waitFor(() => { expect(countFooter()).toHaveTextContent("21 requests"); });
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Open Track 20", { selector: ".list-row__title" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Played" }));
    await screen.findByText("Played Track 00", { selector: ".list-row__title" });
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Played Track 20", { selector: ".list-row__title" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    if (captured.client === null) throw new Error("The dashboard query client was not captured.");
    await refetchModuleQueryData(captured.client, "channel-fictional", "song_requests", "requests:played:2");
    expect(requestCalls.at(-1)).toContain("filter=played");
    expect(requestCalls.at(-1)).toContain("page=2");
    await screen.findByText("Page 2 of 2");

    fireEvent.click(screen.getByRole("button", { name: "Clear list" }));
    expect(await screen.findByRole("heading", { name: "Clear the song request list?" })).toBeInTheDocument();
    const confirmClear = screen.getAllByRole("button", { name: "Clear list" }).at(-1);
    if (confirmClear === undefined) throw new Error("The clear confirmation button is missing.");
    fireEvent.click(confirmClear);
    await waitFor(() => {
      expect(requestCalls.at(-1)).toContain("filter=played");
      expect(requestCalls.at(-1)).toContain("page=1");
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
      expect(countFooter()).toHaveTextContent("0 requests");
      expect(screen.queryByText("Played Track 00", { selector: ".list-row__title" })).not.toBeInTheDocument();
    });
  });

  it("refetches page one after removing the last request on page two without a revision", async () => {
    const requests = Array.from({ length: 21 }, (_, index) => ({
      requestId: `Open-${String(index).padStart(2, "0")}`,
      ...track,
      title: `Open Track ${String(index).padStart(2, "0")}`,
      state: "pending_review",
      failureReason: null,
      source: "points",
      requestType: "free",
      chargedAmount: 0,
      requesterDisplayName: "Fictional Viewer",
      requesterLogin: "fictional_viewer",
      createdAt: `2026-11-15T19:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    let serverRows = requests;
    const requestCalls: Array<{ url: URL; total: number }> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-remove-page" }));
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 1, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/revisions")) return Promise.resolve(json({ revisions: { "module:song_requests:requests": 0 } }));
      if (url.pathname.endsWith("/requests")) {
        requestCalls.push({ url, total: serverRows.length });
        const page = Number(url.searchParams.get("page") ?? "1");
        return Promise.resolve(json(requestsRead(serverRows.slice((page - 1) * 20, page * 20), null, [], "open", page, serverRows.length)));
      }
      if (url.pathname.endsWith("/remove")) {
        const requestId = decodeURIComponent(url.pathname.split("/").at(-2) ?? "");
        serverRows = serverRows.filter((row) => row.requestId !== requestId);
        return Promise.resolve(json({ state: "removed" }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const captured: { client: QueryClient | null } = { client: null };
    render(<DashboardDataProvider><QueryClientCapture onCapture={(client) => { captured.client = client; }}>
      <SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />
    </QueryClientCapture></DashboardDataProvider>);

    await screen.findByText("Open Track 00", { selector: ".list-row__title" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Open Track 20", { selector: ".list-row__title" });
    fireEvent.click(screen.getByRole("button", { name: "Actions: Open Track 20" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(requestCalls.some(({ url, total }) => url.searchParams.get("page") === "1" && url.searchParams.get("filter") === "open" && total === 20)).toBe(true);
      expect(document.querySelector(".list-pagination-footer__count")).toHaveTextContent("20 requests");
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
      expect(screen.getByText("Open Track 19", { selector: ".list-row__title" })).toBeInTheDocument();
      expect(screen.queryByText("Open Track 20", { selector: ".list-row__title" })).not.toBeInTheDocument();
    });
    if (captured.client === null) throw new Error("The dashboard query client was not captured.");
    expect(captured.client.getQueryData(moduleQueryKey("channel-fictional", "song_requests", "requests:open:1"))).toMatchObject({ total: 20, page: 1 });
  });

  it("keys request filters and pages, keeps the previous rows while loading, and refreshes the active view on revision", async () => {
    const requestRow = (requestId: string, title: string) => ({
      requestId, ...track, title, state: "pending_review", failureReason: null, source: "points", requestType: "free",
      chargedAmount: 0, requesterDisplayName: "Fictional Viewer", requesterLogin: "fictional_viewer", createdAt: "2026-11-15T19:00:00.000Z",
    });
    const releases: { one: ((response: Response) => void) | null; two: ((response: Response) => void) | null } = { one: null, two: null };
    let requestRevision = 0;
    let allPageTwoReads = 0;
    const requestCalls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 1, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/revisions")) return Promise.resolve(json({ revisions: { "module:song_requests:requests": requestRevision } }));
      if (url.pathname.endsWith("/requests")) {
        requestCalls.push(url);
        const filter = url.searchParams.get("filter") === "all" ? "all" : "open";
        const page = Number(url.searchParams.get("page") ?? "1");
        if (filter === "all" && page === 1) {
          return new Promise<Response>((resolve) => { releases.one = resolve; });
        }
        if (filter === "all" && page === 2) {
          allPageTwoReads += 1;
          if (allPageTwoReads === 1) return new Promise<Response>((resolve) => { releases.two = resolve; });
          return Promise.resolve(json(requestsRead([requestRow("all-page-two", "All Second Refreshed")], null, [], "all", 2, 21)));
        }
        return Promise.resolve(json(requestsRead([requestRow("open-page-one", "Open First")], null, [], "open", 1, 21)));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const captured: { client: QueryClient | null } = { client: null };
    render(<DashboardDataProvider><QueryClientCapture onCapture={(client) => { captured.client = client; }}>
      <SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />
    </QueryClientCapture></DashboardDataProvider>);

    await screen.findByText("Open First", { selector: ".list-row__title" });
    if (captured.client === null) throw new Error("The dashboard query client was not captured.");
    await reconcileDashboardPanelResourceRevisions(captured.client, "channel-fictional");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(requestCalls.some((url) => url.searchParams.get("filter") === "all" && url.searchParams.get("page") === "1")).toBe(true);
    });
    expect(screen.getByText("Open First", { selector: ".list-row__title" })).toBeInTheDocument();
    if (releases.one === null) throw new Error("The all-filter request did not start.");
    releases.one(json(requestsRead([requestRow("all-page-one", "All First")], null, [], "all", 1, 21)));
    await screen.findByText("All First", { selector: ".list-row__title" });
    await waitFor(() => expect(screen.queryByText("Open First", { selector: ".list-row__title" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(requestCalls.some((url) => url.searchParams.get("filter") === "all" && url.searchParams.get("page") === "2")).toBe(true);
    });
    expect(screen.getByText("All First", { selector: ".list-row__title" })).toBeInTheDocument();
    if (releases.two === null) throw new Error("The second-page request did not start.");
    releases.two(json(requestsRead([requestRow("all-page-two", "All Second")], null, [], "all", 2, 21)));
    await screen.findByText("All Second", { selector: ".list-row__title" });
    await waitFor(() => expect(screen.queryByText("All First", { selector: ".list-row__title" })).not.toBeInTheDocument());
    expect(captured.client.getQueryData(moduleQueryKey("channel-fictional", "song_requests", "requests:open:1"))).toMatchObject({ filter: "open", page: 1 });
    expect(captured.client.getQueryData(moduleQueryKey("channel-fictional", "song_requests", "requests:all:1"))).toMatchObject({ filter: "all", page: 1 });
    expect(captured.client.getQueryData(moduleQueryKey("channel-fictional", "song_requests", "requests:all:2"))).toMatchObject({ filter: "all", page: 2 });

    requestRevision = 1;
    await reconcileDashboardPanelResourceRevisions(captured.client, "channel-fictional");
    expect(requestCalls.at(-1)?.searchParams.get("filter")).toBe("all");
    expect(requestCalls.at(-1)?.searchParams.get("page")).toBe("2");
    await screen.findByText("All Second Refreshed", { selector: ".list-row__title" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("offers removal per request, with the refund choice only for paid submitted requests, behind a confirmation", async () => {
    const row = (requestId: string, title: string, state: string, requestType: string, chargedAmount: number) => ({
      requestId, state, title, artists: ["Mira Vale"], coverUrl: null, spotifyUrl: `https://open.spotify.com/track/${requestId}`,
      failureReason: null, source: "points", requestType, chargedAmount, requesterDisplayName: "Fictional Viewer", requesterLogin: "fictional_viewer", createdAt: "2026-11-15T19:00:00.000Z",
    });
    const requests = [
      row("waiting01", "Waiting Track", "pending_review", "bot_points", 25),
      row("paid02", "Paid Track", "submitted", "bot_points", 25),
      row("free03", "Free Track", "submitted", "free", 0),
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-remove" }));
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 1, state: "connected", streamId: "stream-fictional", emptyText: "", pointsEnabled: true }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json(requestsRead(requests)));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: settings(), revision: 1 }));
      return Promise.resolve(json({ state: "removed" }));
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    await screen.findByText("Paid Track", { selector: ".list-row__title" });

    fireEvent.click(screen.getByRole("button", { name: "Actions: Free Track" }));
    expect(await screen.findByRole("menuitem", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove and refund" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Actions: Paid Track" }));
    expect(await screen.findByRole("menuitem", { name: "Remove and refund" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove and refund" }));
    expect(fetcher.mock.calls.some(([input]) => urlOf(input).pathname.endsWith("/remove"))).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Remove and refund" }));
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([input]) => urlOf(input).pathname.endsWith("/requests/paid02/remove"));
      expect(JSON.parse(typeof call?.[1]?.body === "string" ? call[1].body : "{}")).toEqual({ refund: true });
    });
  });
});
