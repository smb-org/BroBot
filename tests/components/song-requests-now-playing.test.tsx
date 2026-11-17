import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import SongRequestsNowPlaying from "../../src/modules/song_requests/overlay/view";

afterEach(cleanup);

describe("song request now-playing overlay", () => {
  it("hides the retained track while paused and shows it again after resume", () => {
    const now = Date.parse("2026-11-17T19:00:00.000Z");
    const track = {
      id: "glassharbor01",
      title: "Glass Harbor",
      artist: "Mira Vale",
      coverUrl: null,
      spotifyUrl: "https://open.spotify.com/track/glassharbor01",
      requester: "Viewer",
      source: "mod_vote",
      durationMs: 201_000,
      progressMs: 42_000,
    };
    const paused = renderToStaticMarkup(<SongRequestsNowPlaying config={{}} state={{
      revision: 2,
      serverNow: new Date(now).toISOString(),
      track,
      playing: false,
    }} now={now} language="en" />);
    const resumed = renderToStaticMarkup(<SongRequestsNowPlaying config={{}} state={{
      revision: 3,
      serverNow: new Date(now).toISOString(),
      track,
      playing: true,
    }} now={now} language="en" />);

    expect(paused).toContain('visibility:hidden');
    expect(paused).not.toContain("Glass Harbor");
    expect(resumed).toContain("Glass Harbor");
    expect(resumed).not.toContain('visibility:hidden');
  });
});
