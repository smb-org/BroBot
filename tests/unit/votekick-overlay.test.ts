import { describe, expect, it } from "vitest";

import { mergeVotekickOverlayState, isVotekickOverlayState } from "../../src/modules/votekick/overlay/state";
import type { VotekickOverlayState } from "../../src/modules/votekick/overlay/state";
import { votekickOverlayElement } from "../../src/modules/votekick/overlay/element";

const state = (overrides: Partial<VotekickOverlayState> = {}): VotekickOverlayState => ({
  votekickId: "ballot-a",
  targetLogin: "sampleviewer",
  targetUserId: "target-a",
  yesVotes: 1,
  noVotes: 0,
  threshold: 5,
  ballotRevision: 1,
  status: "running",
  startedAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-01T00:01:00.000Z",
  endedAt: null,
  ...overrides,
});

describe("votekick overlay state", () => {
  it("merges newer ballots but ignores stale revisions and post-close updates", () => {
    const current = state({ yesVotes: 4, ballotRevision: 4 });
    expect(mergeVotekickOverlayState(current, state({ yesVotes: 2, ballotRevision: 2 }))).toBe(current);
    expect(mergeVotekickOverlayState(current, state({ yesVotes: 5, ballotRevision: 5 }))).toMatchObject({
      yesVotes: 5,
      ballotRevision: 5,
    });
    const closed = state({ status: "passed", endedAt: "2030-01-01T00:00:30.000Z" });
    expect(mergeVotekickOverlayState(closed, state({ ballotRevision: 9, yesVotes: 9 }))).toBe(closed);
  });

  it("prefers the most recently started ballot and validates bootstrap state", () => {
    const previous = state();
    const newer = state({
      votekickId: "ballot-b",
      startedAt: "2030-01-01T00:02:00.000Z",
      endsAt: "2030-01-01T00:03:00.000Z",
    });
    expect(mergeVotekickOverlayState(previous, newer)).toBe(newer);
    expect(isVotekickOverlayState(newer)).toBe(true);
    expect(isVotekickOverlayState({ ...newer, status: "unknown" })).toBe(false);
    expect(votekickOverlayElement.reloadStateOnModuleMessages).toContain("modul.votekick.opened");
    expect(votekickOverlayElement.mergeRealtimeStateOnModuleMessages).toContain("modul.votekick.tally");
  });
});
