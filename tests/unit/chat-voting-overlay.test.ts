import { describe, expect, it } from "vitest";

import { mergeTallyState, type TallyState } from "../../src/modules/chat_voting/overlay/tally-state";

const tally = (pollId: string, revision: number, status: TallyState["status"] = "open"): TallyState => ({
  pollId,
  revision,
  status,
  labels: ["Yes", "No"],
  counts: [revision, 0],
});

describe("chat voting tally revisions", () => {
  it("keeps the newest counts when a delayed tally arrives", () => {
    const current = tally("poll-a", 4);

    expect(mergeTallyState(current, tally("poll-a", 2))).toBe(current);
    expect(mergeTallyState(current, tally("poll-a", 5))).toMatchObject({ revision: 5, counts: [5, 0] });
  });

  it("accepts authoritative lifecycle state for a new poll and a close", () => {
    expect(mergeTallyState(tally("poll-a", 7), { pollId: "poll-b", revision: 0, status: "open", counts: [0, 0] }))
      .toMatchObject({ pollId: "poll-b", status: "open" });
    expect(mergeTallyState(tally("poll-a", 7), { ...tally("poll-a", 1, "closed"), closedAt: "2026-10-04T10:00:00.000Z" }))
      .toMatchObject({ revision: 1, status: "closed" });
    expect(mergeTallyState(tally("poll-a", 7), { pollId: "poll-b", revision: 0, counts: [0, 0] })?.pollId)
      .toBe("poll-a");
  });
});
