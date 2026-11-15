import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import SongRequestsPanel from "../../src/modules/song_requests/panel";
import SongRequestsNowPlaying from "../../src/modules/song_requests/overlay/view";
import SongRequestsNowPlayingEditor from "../../src/modules/song_requests/overlay/editor";

const track = { id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: "https://i.scdn.co/image/fictional-cover", spotifyUrl: "https://open.spotify.com/track/glassharbor01" };
const urlOf = (input: RequestInfo | URL): URL => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
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
      state={{ revision: 1, serverNow: "2026-11-15T12:00:00.000Z", track: { ...track, artist: "Mira Vale", requester: null, source: "mod_vote" } }}
      now={Date.parse("2026-11-15T12:00:00.000Z")}
      language="en"
    />);
    expect(screen.getByRole("link", { name: "Glass Harbor" })).toHaveAttribute("href", track.spotifyUrl);
    expect(container.querySelector(".song-requests-now-playing__spotify")).toHaveTextContent("Spotify");
    expect(container.querySelector(".song-requests-now-playing__requester")).toHaveTextContent("Song vote");
    expect(container.querySelector(".song-requests-now-playing")).toHaveStyle({ width: "640px", height: "112px" });
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Show cover" }));
    expect(onChange).toHaveBeenCalledWith({ showCover: false, showRequester: true });
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
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled, hasCredentials, slot: enabled ? 2 : null, state, errorMessage: errorMessage ?? null, streamId: null, emptyText: "" }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json({ requests: [], voteOutcomes: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: { emptyText: "Pick a song" }, revision: 3 }));
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
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "" }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json({ requests: [], voteOutcomes: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: { emptyText: "" }, revision: 3 }));
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
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "" }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json({ requests: [], voteOutcomes: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: { emptyText: "" }, revision: 3 }));
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

  it("saves player empty text only after the Save action", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-song-request" }));
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 2, state: "connected", errorMessage: null, streamId: "stream-fictional", emptyText: "Pick a song" }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json({ requests: [], voteOutcomes: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: { emptyText: "Pick a song" }, revision: 3 }));
      return Promise.resolve(json({ settings: { emptyText: "Up next" }, revision: 4 }));
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    const field = await screen.findByRole("textbox", { name: "Player empty text" });
    fireEvent.change(field, { target: { value: "Up next" } });

    expect(fetcher.mock.calls.some(([input, init]) => urlOf(input).pathname.endsWith("/settings") && init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => urlOf(input).pathname.endsWith("/settings") && init?.method === "PATCH")).toBe(true);
    });
    const saveCall = fetcher.mock.calls.find(([input, init]) => urlOf(input).pathname.endsWith("/settings") && init?.method === "PATCH");
    expect(JSON.parse(typeof saveCall?.[1]?.body === "string" ? saveCall[1].body : "{}")).toMatchObject({
      revision: 3,
      settings: { emptyText: "Up next" },
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
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, hasCredentials: true, slot: 3, state: "connected", streamId: "stream-fictional", emptyText: "" }));
      if (url.pathname.endsWith("/requests")) return Promise.resolve(json({ requests: [], voteOutcomes: [{ ballotId: "ballot-tie", state: "tie", createdAt: "2026-11-15T19:00:00.000Z" }] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(json({ settings: { emptyText: "Pick a song" }, revision: 3 }));
      if (url.pathname.endsWith("/search")) return Promise.resolve(json({ tracks: searchTracks }));
      if (url.pathname.endsWith("/vote")) return Promise.resolve(json({ ballotId: "ballot-fictional" }, 201));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();
    await screen.findByText("Spotify is connected.");
    await screen.findByText("Tie · nothing queued");
    fireEvent.change(screen.getByRole("textbox", { name: "Track, Spotify link, or URI" }), { target: { value: "Glass Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Silver Current");
    for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
      fireEvent.click(screen.getByRole("button", { name: `Add ${title} to vote` }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => { expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/vote"), expect.objectContaining({ method: "POST" })); });
    const voteCall = fetcher.mock.calls.find(([input]) => urlOf(input).pathname.endsWith("/vote"));
    const body = voteCall?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "{}")).toEqual({ trackIds: ["glassharbor01", "quietatlas02", "silvercurrent03"] });
  });
});
