import { describe, expect, it } from "vitest";

import { spotifyTrackIdFromInput } from "../../src/modules/song_requests/domain/track";
import { voteWinner } from "../../src/modules/song_requests/domain/vote-result";
import { decideSkipVote } from "../../src/modules/song_requests/domain/skip-result";
import { songVoteLabels } from "../../src/modules/song_requests/domain/vote-labels";
import { formatPlaybackTime, interpolatePlaybackProgress, matchSubmittedRequest, streamOfflineTransitions } from "../../src/modules/song_requests/domain/playback";

describe("Spotify track input", () => {
  it("recognizes Spotify track links and URIs without changing the ID", () => {
    expect(spotifyTrackIdFromInput("https://open.spotify.com/track/AbC123?si=sample")).toBe("AbC123");
    expect(spotifyTrackIdFromInput("spotify:track:AbC123")).toBe("AbC123");
    expect(spotifyTrackIdFromInput("https://example.invalid/track/AbC123")).toBeNull();
  });
});

describe("song vote results", () => {
  it("requires the skip threshold and a strict yes majority", () => {
    expect(decideSkipVote(5, 2, 5)).toBe("skip");
    expect(decideSkipVote(4, 0, 5)).toBe("threshold_not_met");
    expect(decideSkipVote(5, 5, 5)).toBe("no_majority");
    expect(decideSkipVote(4, 5, 3)).toBe("no_majority");
  });

  it("returns a unique winner and resolves ties deterministically from the ballot id", async () => {
    await expect(voteWinner([0, 4, 2], "ballot-single")).resolves.toEqual({ index: 1, drawnByLot: false });
    await expect(voteWinner([0, 0, 0], "ballot-empty")).resolves.toBeNull();
    const firstDraw = await voteWinner([2, 2, 2], "ballot-three-way");
    expect(firstDraw).toMatchObject({ drawnByLot: true });
    // A retried durable action must pick the same track; many retries make a random pick fail reliably.
    for (let retry = 0; retry < 30; retry += 1) {
      expect(await voteWinner([2, 2, 2], "ballot-three-way")).toEqual(firstDraw);
    }
    expect(firstDraw?.index).toBeGreaterThanOrEqual(0);
    expect(firstDraw?.index).toBeLessThan(3);
  });

  it("keeps Spotify option labels within the shared ballot limit and disambiguates matching titles", () => {
    expect(songVoteLabels([
      { name: "Glass Harbor", artists: [{ name: "Mira Vale" }] },
      { name: "Glass Harbor", artists: [{ name: "Mira Vale" }] },
      { name: "A very long fictional song title that will be shortened", artists: [{ name: "Mira Vale" }] },
    ])).toEqual(["Mira Vale – Glass Harbor", "Mira Vale – Glass Harbor (2)", "Mira Vale – A very long fiction…"]);
  });
});

describe("song request playback progress", () => {
  it("interpolates from the last observed snapshot and clamps at the song duration", () => {
    const observedAt = Date.parse("2026-11-15T12:00:00.000Z");
    const progress = interpolatePlaybackProgress(83_000, 296_000, observedAt, observedAt + 10_000);

    expect(progress).toBe(93_000);
    expect(`${formatPlaybackTime(progress)} / ${formatPlaybackTime(296_000)}`).toBe("1:33 / 4:56");
    expect(interpolatePlaybackProgress(290_000, 296_000, observedAt, observedAt + 20_000)).toBe(296_000);
  });

  it("keeps progress at the snapshot time when rendering before that timestamp", () => {
    const observedAt = Date.parse("2026-11-15T12:00:00.000Z");
    const progress = interpolatePlaybackProgress(83_000, 296_000, observedAt, observedAt - 5_000);

    expect(progress).toBe(83_000);
    expect(formatPlaybackTime(progress) + " / " + formatPlaybackTime(296_000)).toBe("1:23 / 4:56");
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
