import { describe, expect, it } from "vitest";

import { spotifyTrackIdFromInput } from "../../src/modules/song_requests/domain/track";
import { voteWinner } from "../../src/modules/song_requests/domain/vote-result";
import { songVoteLabels } from "../../src/modules/song_requests/domain/vote-labels";
import { matchSubmittedRequest, streamOfflineTransitions } from "../../src/modules/song_requests/domain/playback";

describe("Spotify track input", () => {
  it("recognizes Spotify track links and URIs without changing the ID", () => {
    expect(spotifyTrackIdFromInput("https://open.spotify.com/track/AbC123?si=sample")).toBe("AbC123");
    expect(spotifyTrackIdFromInput("spotify:track:AbC123")).toBe("AbC123");
    expect(spotifyTrackIdFromInput("https://example.invalid/track/AbC123")).toBeNull();
  });
});

describe("song vote results", () => {
  it("returns a winner only when exactly one candidate has the highest positive count", () => {
    expect(voteWinner([0, 4, 2])).toBe(1);
    expect(voteWinner([0, 0, 0])).toBeNull();
    expect(voteWinner([2, 2, 0])).toBeNull();
  });

  it("keeps Spotify option labels within the shared ballot limit and disambiguates matching titles", () => {
    expect(songVoteLabels([
      { name: "Glass Harbor" },
      { name: "Glass Harbor" },
      { name: "A very long fictional song title that will be shortened" },
    ])).toEqual(["Glass Harbor", "Glass Harbor (2)", "A very long fictional song title"]);
  });
});

describe("song request playback matching", () => {
  const requests = [
    { id: "old-stream", trackId: "track-a", streamId: "stream-old", state: "submitted" as const, createdAt: "2026-11-14T19:00:00.000Z" },
    { id: "first", trackId: "track-a", streamId: "stream-current", state: "submitted" as const, createdAt: "2026-11-15T19:00:00.000Z" },
    { id: "second", trackId: "track-a", streamId: "stream-current", state: "submitted" as const, createdAt: "2026-11-15T19:01:00.000Z" },
  ];

  it("matches the oldest submitted duplicate from the current stream only", () => {
    expect(matchSubmittedRequest(requests, "track-a", "stream-current")?.id).toBe("first");
  });

  it("leaves unmatched tracks without a requester", () => {
    expect(matchSubmittedRequest(requests, "autoplay-track", "stream-current")).toBeNull();
  });

  it("applies stream offline transitions without refund assumptions", () => {
    expect(streamOfflineTransitions([
      "submitted", "pending_review", "approved", "outcome_unknown", "observed_playing", "failed",
    ])).toEqual(["not_observed", "rejected", "rejected", "failed", null, null]);
  });
});
