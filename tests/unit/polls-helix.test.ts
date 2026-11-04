import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withBroadcasterToken: vi.fn(),
  helixRequest: vi.fn(),
}));

vi.mock("../../src/worker/auth/broadcaster-token", () => ({
  withBroadcasterToken: mocks.withBroadcasterToken,
}));
vi.mock("../../src/worker/twitch/helix", () => ({
  helixRequest: mocks.helixRequest,
}));

import { mapPollsHttpStatus, createPoll, patchPrediction } from "../../src/worker/twitch/polls";
import type { PollsEntryInput } from "../../src/modules/polls/contracts";

const environment = { TWITCH_CLIENT_ID: "fictional-client" } as Env;
const entry: PollsEntryInput = {
  kind: "poll",
  title: "Fictional poll",
  choices: ["First", "Second"],
  durationSeconds: 60,
  channelPointsVotingEnabled: true,
  channelPointsPerVote: 100,
};

describe("polls Helix client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.withBroadcasterToken.mockImplementation(async (
      _environment: Env,
      _broadcasterId: string,
      _scopes: string[],
      request: (accessToken: string) => Promise<unknown>,
    ) => {
      const response = await request("broadcaster-token") as { ok: boolean; status?: number; data?: unknown };
      return response.ok
        ? { kind: "ok", value: response.data }
        : { kind: "http_error", result: response };
    });
    mocks.helixRequest.mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
  });

  it.each([
    [204, null, "success"],
    [400, "Invalid poll input", "invalid_input"],
    [400, "A poll is already active for this broadcaster", "already_active"],
    [403, "This broadcaster is not eligible", "not_eligible"],
    [429, "Too many requests", "rate_limited"],
    [null, null, "network"],
    [503, "Unexpected response", "unknown_status"],
  ] as const)("maps HTTP status %s to %s", (status, message, reason) => {
    expect(mapPollsHttpStatus(status, message)).toBe(reason);
  });

  it("sends poll duration, choices, and channel-points voting values", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(createPoll(environment, "channel_polls", entry, fetcher)).resolves.toEqual({ ok: true, data: [] });

    expect(mocks.withBroadcasterToken.mock.calls[0]?.slice(0, 3)).toEqual([
      environment,
      "channel_polls",
      ["channel:manage:polls"],
    ]);
    expect(mocks.helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/polls",
      method: "POST",
      body: {
        broadcaster_id: "channel_polls",
        title: "Fictional poll",
        choices: [{ title: "First" }, { title: "Second" }],
        duration: 60,
        channel_points_voting_enabled: true,
        channel_points_per_vote: 100,
      },
      fetcher,
    }));
  });

  it("sends a resolved prediction's winning outcome ID", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await patchPrediction(environment, "channel_polls", "twitch_prediction_demo", {
      status: "RESOLVED",
      winningOutcomeId: "outcome_first",
    }, fetcher);

    expect(mocks.helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/predictions",
      method: "PATCH",
      body: {
        broadcaster_id: "channel_polls",
        id: "twitch_prediction_demo",
        status: "RESOLVED",
        winning_outcome_id: "outcome_first",
      },
      fetcher,
    }));
  });
});
