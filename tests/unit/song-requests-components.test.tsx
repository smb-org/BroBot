import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dashboardApi = vi.hoisted(() => ({
  getChannelModuleSettings: vi.fn(),
  saveChannelModuleSettings: vi.fn(),
}));

vi.mock("../../src/dashboard/api", () => dashboardApi);

import SongRequestsPanel from "../../src/modules/song_requests/panel";
import SongRequestsNowPlaying from "../../src/modules/song_requests/overlay/view";
import SongRequestsNowPlayingEditor from "../../src/modules/song_requests/overlay/editor";

const track = { id: "glassharbor01", title: "Glass Harbor", artists: ["Mira Vale"], coverUrl: "https://i.scdn.co/image/fictional-cover", spotifyUrl: "https://open.spotify.com/track/glassharbor01" };

describe("song request components", () => {
  beforeEach(() => {
    dashboardApi.getChannelModuleSettings.mockResolvedValue({ settings: { emptyText: "Pick a song" }, revision: 3 });
    dashboardApi.saveChannelModuleSettings.mockResolvedValue({ revision: 4 });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders a fixed now-playing card with Spotify attribution and vote label", () => {
    const { container } = render(<SongRequestsNowPlaying
      config={{ showCover: true, showRequester: true }}
      state={{ revision: 1, serverNow: "2026-11-15T12:00:00.000Z", track: { ...track, artist: "Mira Vale", requester: null, source: "mod_vote" } }}
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
      language="en"
    />);
    expect(container.querySelector(".song-requests-now-playing")).toHaveStyle({ width: "640px", height: "112px" });
    expect(container.querySelector(".song-requests-now-playing__copy h2")).toHaveTextContent("Pick a song");
    expect(container.querySelector(".song-requests-now-playing__spotify")).toBeEmptyDOMElement();
  });

  it("labels the overlay editor controls and emits its fictional preview", () => {
    const onChange = vi.fn();
    const onPreviewState = vi.fn();
    render(<SongRequestsNowPlayingEditor config={{}} onChange={onChange} onPreviewState={onPreviewState} language="en" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show cover" }));
    expect(onChange).toHaveBeenCalledWith({ showCover: false, showRequester: true });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreviewState).toHaveBeenCalledWith(expect.objectContaining({ track: expect.objectContaining({ title: "Glass Harbor", artist: "Mira Vale" }) }));
  });

  it.each([
    { state: "not_enabled", enabled: false, message: "Spotify is not enabled for this channel." },
    { state: "not_connected", enabled: true, message: "Spotify is not connected yet." },
    { state: "connected", enabled: true, message: "Spotify is connected." },
    { state: "spotify_error", enabled: true, errorMessage: "Insufficient Spotify scope", message: "Insufficient Spotify scope" },
    { state: "premium_required", enabled: true, message: "The connected account needs Spotify Premium for playback." },
    { state: "no_active_device", enabled: true, message: "Spotify found no active playback device. Start Spotify on a device." },
    { state: "reconnect_required", enabled: true, message: "The connection needs to be renewed." },
  ])("explains the $state connection state", async ({ state, enabled, message, errorMessage }) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/connection")) return new Response(JSON.stringify({ enabled, hasCredentials: enabled && state !== "not_connected", slot: enabled ? 2 : null, state, errorMessage: errorMessage ?? null, streamId: null, emptyText: "" }), { status: 200 });
      if (url.pathname.endsWith("/requests")) return new Response(JSON.stringify({ requests: [], voteOutcomes: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }));
    render(<SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />);
    await screen.findByText(message);
    if (enabled && state !== "not_connected") await screen.findByRole("button", { name: "Reconnect" });
  });

  it("shows Spotify state and starts a vote from a deterministic three-track search", async () => {
    const searchTracks = [
      { ...track, id: "glassharbor01", spotifyUrl: "https://open.spotify.com/track/glassharbor01" },
      { ...track, id: "quietatlas02", title: "Quiet Atlas", spotifyUrl: "https://open.spotify.com/track/quietatlas02" },
      { ...track, id: "silvercurrent03", title: "Silver Current", spotifyUrl: "https://open.spotify.com/track/silvercurrent03" },
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/csrf") return new Response(JSON.stringify({ token: "csrf-e2e" }), { status: 200 });
      if (url.pathname.endsWith("/connection")) return new Response(JSON.stringify({ enabled: true, hasCredentials: true, slot: 3, state: "connected", streamId: "stream-fictional", emptyText: "" }), { status: 200 });
      if (url.pathname.endsWith("/requests")) return new Response(JSON.stringify({ requests: [], voteOutcomes: [{ ballotId: "ballot-tie", state: "tie", createdAt: "2026-11-15T19:00:00.000Z" }] }), { status: 200 });
      if (url.pathname.endsWith("/search")) return new Response(JSON.stringify({ tracks: searchTracks }), { status: 200 });
      if (url.pathname.endsWith("/vote")) return new Response(JSON.stringify({ ballotId: "ballot-fictional" }), { status: 201 });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<SongRequestsPanel channelId="channel-fictional" language="en" canManage canOperate />);
    await screen.findByText("Spotify is connected.");
    await screen.findByText("Tie · nothing queued");
    fireEvent.change(screen.getByRole("textbox", { name: "Track, Spotify link, or URI" }), { target: { value: "Glass Harbor" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Silver Current");
    for (const title of ["Glass Harbor", "Quiet Atlas", "Silver Current"]) {
      const row = screen.getByText(title).closest("article");
      if (row === null) throw new Error("Track row is missing.");
      fireEvent.click(row.querySelector("button") as HTMLButtonElement);
    }
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/vote"), expect.objectContaining({ method: "POST" })));
    const voteCall = fetcher.mock.calls.find(([input]) => new URL(String(input), window.location.origin).pathname.endsWith("/vote"));
    expect(JSON.parse(String(voteCall?.[1]?.body))).toEqual({ trackIds: ["glassharbor01", "quietatlas02", "silvercurrent03"] });
  });
});
