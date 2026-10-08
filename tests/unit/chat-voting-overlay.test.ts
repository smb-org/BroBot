import { describe, expect, it } from "vitest";

import { chatVotingOverlayElement } from "../../src/modules/chat_voting/overlay/element";
import { mergeTallyRealtimeState, mergeTallyState, type TallyState } from "../../src/modules/chat_voting/overlay/tally-state";

const tally = (
  pollId: string,
  revision: number,
  status: TallyState["status"] = "open",
  openedAt = "2026-10-04T10:00:00.000Z",
): TallyState => ({
  pollId,
  openedAt,
  revision,
  status,
  labels: ["Yes", "No"],
  counts: [revision, 0],
});

describe("chat voting tally state", () => {
  it("defaults the countdown option on and accepts it as an element setting", () => {
    expect(chatVotingOverlayElement.defaultConfig.showCountdown).toBe(true);
    expect(chatVotingOverlayElement.parseConfig({})).toMatchObject({ showCountdown: true });
    expect(chatVotingOverlayElement.parseConfig({ showCountdown: false })).toMatchObject({ showCountdown: false });
  });

  it("keeps the newest counts when a delayed tally arrives", () => {
    const current = tally("poll-a", 4);

    expect(mergeTallyState(current, tally("poll-a", 2))).toBe(current);
    expect(mergeTallyState(current, tally("poll-a", 5))).toMatchObject({ revision: 5, counts: [5, 0] });
  });

  it("replaces reducer state with a null or lower-revision closed snapshot", () => {
    const current = tally("poll-a", 7);
    const closed = {
      ...tally("poll-a", 0, "closed"),
      counts: [4, 2],
      closedAt: "2026-10-04T10:05:00.000Z",
    };

    expect(mergeTallyState(current, null)).toBeNull();
    expect(mergeTallyState(current, closed)).toEqual(closed);
  });

  it("keeps closed counts final even when the close revision is lower", () => {
    const current = tally("poll-a", 7);
    const closed = mergeTallyState(current, {
      ...tally("poll-a", 0, "closed"),
      counts: [4, 2],
      closedAt: "2026-10-04T10:05:00.000Z",
    });

    expect(closed).toMatchObject({ revision: 0, counts: [4, 2], status: "closed" });
    expect(mergeTallyState(closed, tally("poll-a", 8))).toBe(closed);
  });

  it("accepts only newer polls and ignores old close retries", () => {
    const pollA = tally("poll-a", 7, "open", "2026-10-04T10:00:00.000Z");
    const pollB = tally("poll-b", 0, "open", "2026-10-04T10:01:00.000Z");
    const newer = mergeTallyState(pollA, pollB);
    const oldClose = { ...tally("poll-a", 0, "closed", "2026-10-04T10:00:00.000Z"), counts: [7, 0] };

    expect(newer).toBe(pollB);
    expect(mergeTallyState(newer, oldClose)).toBe(newer);
    expect(mergeTallyState(newer, { pollId: "poll-c", revision: 0, counts: [0, 0] })).toBe(newer);
  });

  it("keeps prior module metadata when a partial tally omits labels", () => {
    const current = { ...tally("poll-a", 2), title: "Pizza today?" };

    expect(mergeTallyState(current, { pollId: "poll-a", revision: 3, counts: [2, 1] }))
      .toMatchObject({ labels: ["Yes", "No"], title: "Pizza today?", counts: [2, 1], status: "open" });
    expect(mergeTallyState(current, { ...tally("poll-a", 3), title: "Which pizza?" }))
      .toMatchObject({ title: "Which pizza?", revision: 3 });
    expect(mergeTallyState(current, null)).toBeNull();
  });

  it("keeps a server bootstrap with closedAt null against stale realtime payloads", () => {
    const bootstrap = {
      pollId: "poll-a", status: "open", preset: "yes_no", optionCount: 2, labels: ["Yes", "No"], counts: [3, 1],
      revision: 5, openedAt: "2026-10-04T10:00:00.000Z", closesAt: "2026-10-04T14:00:00.000Z",
      closedAt: null, closeReason: "limit", voterCount: null,
    };
    const delayed = mergeTallyRealtimeState(bootstrap, { pollId: "poll-a", revision: 2, counts: [1, 0] });
    expect(delayed).toMatchObject({ revision: 5, counts: [3, 1], labels: ["Yes", "No"] });

    const newer = mergeTallyRealtimeState(bootstrap, {
      pollId: "poll-b", revision: 0, counts: [0, 0], openedAt: "2026-10-04T10:01:00.000Z",
    });
    const oldClose = { pollId: "poll-a", status: "closed", revision: 0, counts: [3, 1], openedAt: bootstrap.openedAt };
    expect(mergeTallyRealtimeState(newer, oldClose)).toBe(newer);
  });
});
