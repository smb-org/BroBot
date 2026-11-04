import { describe, expect, it } from "vitest";

import type { RunSnapshot } from "../../src/modules/polls/domain/runs";
import { shouldApplySnapshot, snapshotFromEventSub, snapshotFromHelixPoll } from "../../src/modules/polls/domain/runs";

const snapshot = (overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({
  kind: "prediction",
  twitchId: "twitch_prediction_demo",
  title: "Fictional prediction",
  choices: [],
  status: "active",
  startedAt: "2026-11-04T12:00:00.000Z",
  endsAt: null,
  lockedAt: null,
  endedAt: null,
  winningChoiceId: null,
  observedAt: "2026-11-04T12:00:01.000Z",
  terminalPayload: null,
  ...overrides,
});

describe("polls run domain", () => {
  it.each([
    ["progress after end", { status: "resolved", lastEventAt: "2026-11-04T12:00:03.000Z" }, snapshot()],
    ["lock after progress", { status: "active", lastEventAt: "2026-11-04T12:00:03.000Z" }, snapshot({ status: "locked" })],
    ["progress with an older observation", { status: "active", lastEventAt: "2026-11-04T12:00:03.000Z" }, snapshot({ observedAt: "2026-11-04T12:00:02.000Z" })],
    ["unknown followed by active", { status: "unknown", lastEventAt: "2026-11-04T12:00:03.000Z" }, snapshot()],
  ] as const)("applies the status ordering for %s", (_name, current, next) => {
    const expected = next.status === "locked" || current.status === "unknown";
    expect(shouldApplySnapshot(current, next)).toBe(expected);
  });

  it("parses a resolved prediction end and preserves its winning outcome", () => {
    expect(snapshotFromEventSub("channel.prediction.end", {
      id: "twitch_prediction_demo",
      broadcaster_user_id: "channel_polls",
      title: "Fictional prediction",
      outcomes: [{ id: "outcome_first", title: "First", users: 3, channel_points: 90 }],
      status: "resolved",
      started_at: "2026-11-04T12:00:00.000Z",
      ended_at: "2026-11-04T12:02:00.000Z",
      winning_outcome_id: "outcome_first",
    }, "2026-11-04T12:02:00.100Z")).toMatchObject({
      kind: "prediction",
      status: "resolved",
      winningChoiceId: "outcome_first",
      terminalPayload: expect.objectContaining({ winning_outcome_id: "outcome_first" }) as unknown,
    });
  });

  it("ignores an unknown EventSub subscription type", () => {
    expect(snapshotFromEventSub("channel.prediction.unknown", {
      id: "twitch_prediction_demo",
      title: "Fictional prediction",
      outcomes: [{ id: "outcome_first", title: "First", users: 0, channel_points: 0 }],
      started_at: "2026-11-04T12:00:00.000Z",
    }, "2026-11-04T12:00:00.000Z")).toBeNull();
  });

  it("preserves Helix poll vote and channel-points totals", () => {
    expect(snapshotFromHelixPoll({
      id: "twitch_poll_demo",
      title: "Fictional poll",
      choices: [{ id: "choice_first", title: "First", votes: 4, channel_points_votes: 80 }],
      status: "ACTIVE",
      started_at: "2026-11-04T12:00:00.000Z",
    }, "2026-11-04T12:00:01.000Z").choices).toEqual([{
      id: "choice_first",
      title: "First",
      votes: 4,
      users: null,
      channelPoints: 80,
    }]);
  });
});
