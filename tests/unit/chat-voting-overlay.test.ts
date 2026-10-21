import { describe, expect, it } from "vitest";

import { chatVotingOverlayElement } from "../../src/modules/chat_voting/overlay/element";
import { mergeTallyRealtimeState, mergeTallyState, parseTallyState, type TallyState } from "../../src/modules/chat_voting/overlay/tally-state";

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
  it("defaults countdown and vote colors on and accepts both as element settings", () => {
    expect(chatVotingOverlayElement.defaultConfig.showCountdown).toBe(true);
    expect(chatVotingOverlayElement.defaultConfig.useVoteColors).toBe(true);
    expect(chatVotingOverlayElement.parseConfig({})).toMatchObject({ showCountdown: true, useVoteColors: true });
    expect(chatVotingOverlayElement.parseConfig({ showCountdown: false, useVoteColors: false })).toMatchObject({ showCountdown: false, useVoteColors: false });
  });

  it("keeps the newest counts when a delayed tally arrives", () => {
    const current = tally("poll-a", 4);

    expect(mergeTallyState(current, tally("poll-a", 2))).toBe(current);
    expect(mergeTallyState(current, tally("poll-a", 5))).toMatchObject({ revision: 5, counts: [5, 0] });
  });

  it("keeps an extended deadline when a later ballot revision carries stale deadline metadata", () => {
    const current = {
      ...tally("poll-a", 4),
      closesAt: "2026-10-04T14:02:00.000Z",
      deadlineRevision: 2,
    } as TallyState;
    const delayed = {
      ...tally("poll-a", 5),
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    } as TallyState;

    expect(mergeTallyState(current, delayed)).toMatchObject({
      closesAt: "2026-10-04T14:02:00.000Z",
      deadlineRevision: 2,
      counts: [5, 0],
    });
  });

  it("accepts a newer deadline carried by an older ballot revision", () => {
    const current = {
      ...tally("poll-a", 11),
      closesAt: "2026-10-04T14:00:00.000Z",
      deadlineRevision: 0,
    } as TallyState;
    const extension = {
      ...tally("poll-a", 10),
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    } as TallyState;

    expect(mergeTallyState(current, extension)).toMatchObject({
      revision: 11,
      counts: [11, 0],
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    });
  });

  it("preserves deadline revisions through the renderer parser before merging stale messages", () => {
    const current = parseTallyState({
      ...tally("poll-a", 4),
      closesAt: "2026-10-04T14:02:00.000Z",
      deadlineRevision: 2,
    });
    const delayed = parseTallyState({
      ...tally("poll-a", 5),
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    });

    expect(current?.deadlineRevision).toBe(2);
    expect(mergeTallyState(current, delayed)).toMatchObject({
      closesAt: "2026-10-04T14:02:00.000Z",
      deadlineRevision: 2,
      counts: [5, 0],
    });
  });

  it("keeps a claimed close state when a delayed open tally arrives", () => {
    const closing = {
      ...tally("poll-a", 4, "closing"),
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    } as TallyState;
    const delayedOpen = {
      ...tally("poll-a", 5, "open"),
      closesAt: "2026-10-04T14:01:00.000Z",
      deadlineRevision: 1,
    } as TallyState;

    expect(mergeTallyState(closing, delayedOpen)).toMatchObject({ status: "closing", revision: 5, counts: [5, 0] });
  });

  it("replaces reducer state with a null or lower-revision closed snapshot", () => {
    const current = tally("poll-a", 7);
    const closed = {
      ...tally("poll-a", 0, "closed"),
      counts: [4, 2],
      closedAt: "2026-10-04T10:05:00.000Z",
    };

    expect(mergeTallyState(current, null)).toBeNull();
    expect(mergeTallyState(current, closed)).toMatchObject(closed);
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

  it("keeps a newer deadline while accepting terminal state from a lower deadline revision", () => {
    const current = {
      ...tally("poll-a", 7),
      closesAt: "2026-10-04T14:02:00.000Z",
      requestedDurationSeconds: 300,
      deadlineRevision: 2,
    };
    const closed = mergeTallyState(current, {
      ...tally("poll-a", 0, "closed"),
      closesAt: "2026-10-04T14:00:00.000Z",
      requestedDurationSeconds: 120,
      deadlineRevision: 1,
      counts: [4, 2],
      closedAt: "2026-10-04T10:05:00.000Z",
    });

    expect(closed).toMatchObject({
      status: "closed",
      revision: 0,
      counts: [4, 2],
      closesAt: "2026-10-04T14:02:00.000Z",
      requestedDurationSeconds: 300,
      deadlineRevision: 2,
    });
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

  it("accepts legacy preset payloads and new kind payloads in the same open overlay", () => {
    const legacy = {
      pollId: "legacy-poll",
      openedAt: "2026-10-04T10:00:00.000Z",
      status: "open",
      preset: "digit_01",
      optionCount: 2,
      labels: ["No", "Yes"],
      counts: [3, 7],
      revision: 4,
    };
    const next = mergeTallyRealtimeState(legacy, {
      pollId: "legacy-poll",
      openedAt: legacy.openedAt,
      status: "open",
      kind: "options",
      preset: "options_n",
      optionCount: 2,
      labels: ["No", "Yes"],
      counts: [4, 8],
      revision: 5,
    });
    expect(next).toMatchObject({ kind: "options", preset: "options_n", labels: ["No", "Yes"], counts: [4, 8] });

    const newPayloadWithoutCompatibilityPreset = mergeTallyRealtimeState(null, {
      pollId: "new-poll",
      kind: "options",
      optionCount: 2,
      labels: ["Tea", "Coffee"],
      counts: [1, 2],
      revision: 1,
    });
    expect(newPayloadWithoutCompatibilityPreset).toMatchObject({ kind: "options", counts: [1, 2] });
  });

  it("preserves answer colors from the voting snapshot through realtime tally updates", () => {
    const color = "#5b8cff";
    const current = parseTallyState({ ...tally("colored-poll", 1), answerColors: [color, "#ff9f43"] });
    expect(current?.answerColors).toEqual([color, "#ff9f43"]);
    expect(mergeTallyState(current, { pollId: "colored-poll", revision: 2, counts: [2, 1] }))
      .toMatchObject({ answerColors: [color, "#ff9f43"], counts: [2, 1] });
  });
});
