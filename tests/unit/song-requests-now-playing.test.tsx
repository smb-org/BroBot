import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clickSelectOption } from "../query-test-utils";
import { DisabledFieldReasonContext } from "../../src/dashboard/ui/DisabledFieldReason";
import SongRequestsNowPlayingEditor from "../../src/modules/song_requests/overlay/editor";
import SongRequestsNowPlaying from "../../src/modules/song_requests/overlay/view";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig, parseNowPlayingState } from "../../src/modules/song_requests/overlay/state";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const state = (trackId: string | null, options: { revision?: number; playing?: boolean; emptyText?: string; album?: string | null } = {}) => ({
  revision: options.revision ?? 1,
  serverNow: new Date(NOW).toISOString(),
  track: trackId === null ? null : {
    id: trackId,
    title: "Glass Harbor",
    artist: "Mira Vale",
    ...(options.album === undefined ? {} : { album: options.album }),
    coverUrl: "https://i.scdn.co/image/fictional-cover",
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
    requester: "Fictional Viewer",
    source: "free",
    durationMs: 240_000,
    progressMs: 93_000,
  },
  playing: options.playing ?? true,
  ...(options.emptyText === undefined ? {} : { emptyText: options.emptyText }),
});

const renderView = (config: Record<string, unknown>, currentState: ReturnType<typeof state>, editorPreview = false) =>
  render(<SongRequestsNowPlaying config={config} state={currentState} now={NOW} language="en" editorPreview={editorPreview} />);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("song requests now playing config", () => {
  it("defaults new options when parsing a saved three-key config", () => {
    expect(parseNowPlayingConfig({ showCover: false, showRequester: false, showProgress: true })).toEqual({
      ...DEFAULT_NOW_PLAYING_CONFIG,
      showCover: false,
      showRequester: false,
      showProgress: true,
    });
  });

  it("preserves the old combined time-and-bar switch when a saved config disabled progress", () => {
    expect(parseNowPlayingConfig({ showCover: true, showRequester: true, showProgress: false })?.showTime).toBe(false);
  });

  it("clamps the display duration to two through sixty whole seconds", () => {
    expect(parseNowPlayingConfig({ showDurationSeconds: 1.9 })?.showDurationSeconds).toBe(2);
    expect(parseNowPlayingConfig({ showDurationSeconds: 61 })?.showDurationSeconds).toBe(60);
  });

  it("rejects invalid display modes and unknown config keys", () => {
    expect(parseNowPlayingConfig({ displayMode: "sometimes" })).toBeNull();
    expect(parseNowPlayingConfig({ extra: true })).toBeNull();
  });

  it("keeps older track snapshots valid when they do not include an album", () => {
    expect(parseNowPlayingState(state("quietatlas01"))).not.toBeNull();
  });

  it("normalizes the album name from an older snapshot", () => {
    const currentState = state("quietatlas01", { album: "Quiet Water" });
    if (currentState.track === null) throw new Error("The test state needs a track.");
    const { album, ...trackWithoutAlbum } = currentState.track;
    expect(album).toBe("Quiet Water");
    const legacyState = { ...currentState, track: { ...trackWithoutAlbum, albumName: "Older Album" } };
    expect(parseNowPlayingState(legacyState)?.track?.album).toBe("Older Album");
  });
});

describe("song requests now playing view", () => {
  const fieldSelectors = [
    ["showCover", ".song-requests-now-playing__cover"],
    ["showTitle", ".song-requests-now-playing__title"],
    ["showArtist", ".song-requests-now-playing__artist"],
    ["showAlbum", ".song-requests-now-playing__album"],
    ["showProgress", ".song-requests-now-playing__progress-track"],
    ["showTime", ".song-requests-now-playing__time"],
    ["showRequester", ".song-requests-now-playing__requester"],
  ] as const;

  it.each(fieldSelectors)("removes only the %s field when it is switched off", (key, selector) => {
    const config = { ...DEFAULT_NOW_PLAYING_CONFIG, showAlbum: true, [key]: false };
    const { container } = renderView(config, state("quietatlas01"));
    const root = container.querySelector(".song-requests-now-playing");
    expect(root?.querySelector(selector)).toBeNull();
    for (const [, otherSelector] of fieldSelectors) {
      if (otherSelector !== selector) expect(root?.querySelector(otherSelector)).not.toBeNull();
    }
    expect(root).toHaveStyle({ width: "640px", height: "112px" });
  });

  it("shows an album when enabled and present in the snapshot", () => {
    const { container } = renderView({ ...DEFAULT_NOW_PLAYING_CONFIG, showAlbum: true }, state("quietatlas01", { album: "Quiet Water" }));
    expect(container.querySelector(".song-requests-now-playing__album")).toHaveTextContent("Quiet Water");
  });

  it("shows always mode with a track or configured empty text and hides an empty idle card", () => {
    const withTrack = renderView({ displayMode: "always" }, state("quietatlas01"));
    expect(withTrack.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
    withTrack.unmount();

    const withEmptyText = renderView({ displayMode: "always" }, state(null, { emptyText: "Pick a song" }));
    expect(withEmptyText.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
    expect(withEmptyText.container.querySelector(".song-requests-now-playing__title")).toHaveTextContent("Pick a song");
    withEmptyText.unmount();

    const idle = renderView({ displayMode: "always" }, state(null));
    expect(idle.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows playing mode only while an actual track is playing", () => {
    const playing = renderView({ displayMode: "playing" }, state("quietatlas01"));
    expect(playing.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
    playing.rerender(<SongRequestsNowPlaying config={{ displayMode: "playing" }} state={state("quietatlas01", { playing: false })} now={NOW} language="en" />);
    expect(playing.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
    playing.rerender(<SongRequestsNowPlaying config={{ displayMode: "playing" }} state={state(null, { emptyText: "Pick a song" })} now={NOW} language="en" />);
    expect(playing.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows on a new playing track id and hides after the configured duration", () => {
    vi.useFakeTimers();
    const view = renderView({ displayMode: "on_change", showDurationSeconds: 3 }, state(null));
    expect(view.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");

    view.rerender(<SongRequestsNowPlaying config={{ displayMode: "on_change", showDurationSeconds: 3 }} state={state("quietatlas01")} now={NOW} language="en" />);
    expect(view.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");

    act(() => { vi.advanceTimersByTime(2_999); });
    expect(view.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
  });

  it("hides on pause in on-change mode", () => {
    const view = renderView({ displayMode: "on_change" }, state(null));
    view.rerender(<SongRequestsNowPlaying config={{ displayMode: "on_change" }} state={state("quietatlas01")} now={NOW} language="en" />);
    expect(view.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
    view.rerender(<SongRequestsNowPlaying config={{ displayMode: "on_change" }} state={state("quietatlas01", { playing: false })} now={NOW} language="en" />);
    expect(view.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
  });

  it("does not show again for a same-id revision or a reload", () => {
    vi.useFakeTimers();
    const firstView = renderView({ displayMode: "on_change", showDurationSeconds: 2 }, state(null));
    firstView.rerender(<SongRequestsNowPlaying config={{ displayMode: "on_change", showDurationSeconds: 2 }} state={state("quietatlas01")} now={NOW} language="en" />);
    act(() => { vi.advanceTimersByTime(2_000); });
    firstView.rerender(<SongRequestsNowPlaying config={{ displayMode: "on_change", showDurationSeconds: 2 }} state={state("quietatlas01", { revision: 2 })} now={NOW} language="en" />);
    expect(firstView.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");

    firstView.unmount();
    const reloaded = renderView({ displayMode: "on_change", showDurationSeconds: 2 }, state("quietatlas01", { revision: 2 }));
    expect(reloaded.getByTestId("song-requests-now-playing")).toHaveAttribute("aria-hidden", "true");
  });

  it("hides on pause and keeps the full box for visible and hidden states", () => {
    const view = renderView({ displayMode: "playing" }, state("quietatlas01"));
    const root = view.getByTestId("song-requests-now-playing");
    const visibleBox = { width: root.style.width, height: root.style.height };
    view.rerender(<SongRequestsNowPlaying config={{ displayMode: "playing" }} state={state("quietatlas01", { playing: false })} now={NOW} language="en" />);
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect({ width: root.style.width, height: root.style.height }).toEqual(visibleBox);
  });

  it("keeps the on-change preview visible inside the editor", () => {
    const view = renderView({ displayMode: "on_change" }, state("quietatlas01"), true);
    expect(view.getByTestId("song-requests-now-playing")).not.toHaveAttribute("aria-hidden", "true");
  });
});

describe("song requests now playing editor", () => {
  it("uses the shared display mode select and emits its selected value", async () => {
    const onChange = vi.fn();
    render(<SongRequestsNowPlayingEditor config={{}} onChange={onChange} language="en" />);
    const mode = screen.getByRole("combobox", { name: "Display mode" });
    expect(mode.closest(".ui-select")).not.toBeNull();
    fireEvent.click(mode);
    clickSelectOption(await screen.findByRole("option", { name: "On track change", hidden: true }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ displayMode: "on_change" }));
  });

  it("activates the reserved seconds field only in on-change mode", () => {
    const onChange = vi.fn();
    const editor = (displayMode: "always" | "on_change") => <SongRequestsNowPlayingEditor
      config={{ ...DEFAULT_NOW_PLAYING_CONFIG, displayMode }} onChange={onChange} language="en" />;
    const view = render(editor("always"));
    expect(screen.queryByRole("spinbutton", { name: "Show for (s)" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".song-requests-now-playing-editor__duration-slot")).toHaveStyle({ visibility: "hidden" });

    view.rerender(editor("on_change"));
    expect(screen.getByRole("spinbutton", { name: "Show for (s)" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Show for (s)" })).toHaveAttribute("min", "2");
    expect(screen.getByRole("spinbutton", { name: "Show for (s)" })).toHaveAttribute("max", "60");
  });

  it("writes a clamped duration from the seconds field", () => {
    const onChange = vi.fn();
    render(<SongRequestsNowPlayingEditor config={{ ...DEFAULT_NOW_PLAYING_CONFIG, displayMode: "on_change" }} onChange={onChange} language="en" />);
    const seconds = screen.getByRole("spinbutton", { name: "Show for (s)" });
    fireEvent.change(seconds, { target: { value: "77" } });
    fireEvent.keyDown(seconds, { key: "Enter", code: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showDurationSeconds: 60 }));
  });

  it.each([
    ["Show cover", "showCover"],
    ["Show title", "showTitle"],
    ["Show artist", "showArtist"],
    ["Show album", "showAlbum"],
    ["Show progress bar", "showProgress"],
    ["Show playback time", "showTime"],
    ["Show requester", "showRequester"],
  ] as const)("writes the %s switch to %s", (label, key) => {
    const onChange = vi.fn();
    render(<SongRequestsNowPlayingEditor config={{ ...DEFAULT_NOW_PLAYING_CONFIG }} onChange={onChange} language="en" />);
    fireEvent.click(screen.getByRole("switch", { name: label }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ [key]: !DEFAULT_NOW_PLAYING_CONFIG[key] }));
  });

  it("disables the mode, duration, and every field switch in read-only mode", () => {
    const reason = "Only editors can change this overlay.";
    render(<DisabledFieldReasonContext.Provider value={{ id: "now-playing-readonly", reason }}>
      <p id="now-playing-readonly" className="sr-only">{reason}</p>
      <SongRequestsNowPlayingEditor
        config={{ ...DEFAULT_NOW_PLAYING_CONFIG, displayMode: "on_change" }} onChange={vi.fn()} onPreviewState={vi.fn()} language="en" readOnly />
    </DisabledFieldReasonContext.Provider>);
    const controls = [screen.getByRole("combobox", { name: "Display mode" }), screen.getByRole("spinbutton", { name: "Show for (s)" }), ...screen.getAllByRole("switch")];
    expect(controls).toHaveLength(9);
    for (const control of controls) expect(control).toBeDisabled();
    for (const control of controls) expect(control).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
  });
});
