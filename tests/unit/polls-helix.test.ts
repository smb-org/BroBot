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

import {
  mapPollsHttpStatus,
  createPoll,
  createPrediction,
  endPoll,
  patchPrediction,
} from "../../src/worker/twitch/polls";
import type { PollsEntryInput } from "../../src/modules/polls/contracts";

const environment = { TWITCH_CLIENT_ID: "fictional-client" } as Env;
const authorized = (): Promise<boolean> => Promise.resolve(true);
const entry: PollsEntryInput = {
  kind: "poll",
  title: "Fictional poll",
  choices: ["First", "Second"],
  durationSeconds: 60,
  channelPointsVotingEnabled: true,
  channelPointsPerVote: 100,
};
const predictionEntry: PollsEntryInput = {
  ...entry,
  kind: "prediction",
  durationSeconds: 120,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: null,
};

const helixPoll = {
  id: "twitch_poll_fictional",
  broadcaster_id: "channel_polls",
  broadcaster_name: "Polls Demo",
  broadcaster_login: "polls_demo",
  title: "Fictional poll",
  choices: [
    { id: "choice_first", title: "First", votes: 3, channel_points_votes: 60, bits_votes: 0 },
    { id: "choice_second", title: "Second", votes: 1, channel_points_votes: 20, bits_votes: 0 },
  ],
  bits_voting_enabled: false,
  bits_per_vote: 0,
  channel_points_voting_enabled: true,
  channel_points_per_vote: 100,
  status: "ACTIVE",
  duration: 60,
  started_at: "2026-11-04T12:00:00.000Z",
  ended_at: null,
};

const helixPrediction = {
  id: "twitch_prediction_fictional",
  broadcaster_id: "channel_polls",
  broadcaster_name: "Polls Demo",
  broadcaster_login: "polls_demo",
  title: "Fictional prediction",
  winning_outcome_id: null,
  outcomes: [
    {
      id: "outcome_first",
      title: "First",
      users: 4,
      channel_points: 120,
      top_predictors: [{
        user_name: "Predictor Demo",
        user_login: "predictor_demo",
        user_id: "user_predictor_fictional",
        channel_points_won: null,
        channel_points_used: 25,
      }],
      color: "BLUE",
    },
    { id: "outcome_second", title: "Second", users: 1, channel_points: 20, top_predictors: null, color: "PINK" },
  ],
  prediction_window: 120,
  status: "ACTIVE",
  created_at: "2026-11-04T12:00:00.000Z",
  ended_at: null,
  locked_at: null,
};

describe("polls Helix client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.withBroadcasterToken.mockImplementation(async (
      _environment: Env,
      _broadcasterId: string,
      _scopes: string[],
      request: (accessToken: string) => Promise<unknown>,
      dependencies?: { beforeCall?: () => Promise<boolean> },
    ) => {
      if (dependencies?.beforeCall !== undefined && !await dependencies.beforeCall()) {
        return { kind: "precondition_failed" };
      }
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

    await expect(createPoll(environment, "channel_polls", entry, authorized, fetcher)).resolves.toEqual({ ok: true, data: [] });

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

  it("validates the Helix poll response shape", async () => {
    await createPoll(environment, "channel_polls", entry, authorized);

    const options = mocks.helixRequest.mock.calls[0]?.[0] as { schema: { safeParse: (value: unknown) => { success: boolean } } };
    expect(options.schema.safeParse({ data: [helixPoll] }).success).toBe(true);
    expect(options.schema.safeParse({ data: [{ ...helixPoll, bits_per_vote: undefined }] }).success).toBe(false);
    expect(options.schema.safeParse({ data: [{ ...helixPoll, broadcaster_login: undefined }] }).success).toBe(false);
  });

  it("sends a resolved prediction's winning outcome ID", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await patchPrediction(environment, "channel_polls", "twitch_prediction_fictional", {
      status: "RESOLVED",
      winningOutcomeId: "outcome_first",
    }, authorized, fetcher);

    expect(mocks.helixRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://api.twitch.tv/helix/predictions",
      method: "PATCH",
      body: {
        broadcaster_id: "channel_polls",
        id: "twitch_prediction_fictional",
        status: "RESOLVED",
        winning_outcome_id: "outcome_first",
      },
      fetcher,
    }));
  });

  it("validates the Helix prediction response shape", async () => {
    await patchPrediction(environment, "channel_polls", "twitch_prediction_fictional", { status: "LOCKED" }, authorized);

    const options = mocks.helixRequest.mock.calls[0]?.[0] as { schema: { safeParse: (value: unknown) => { success: boolean } } };
    expect(options.schema.safeParse({ data: [helixPrediction] }).success).toBe(true);
    expect(options.schema.safeParse({ data: [{ ...helixPrediction, created_at: undefined }] }).success).toBe(false);
    expect(options.schema.safeParse({ data: [{ ...helixPrediction, broadcaster_login: undefined }] }).success).toBe(false);
  });

  it.each([
    ["poll creation", (authorize: () => Promise<boolean>, fetcher: typeof fetch) =>
      createPoll(environment, "channel_polls", entry, authorize, fetcher)],
    ["poll ending", (authorize: () => Promise<boolean>, fetcher: typeof fetch) =>
      endPoll(environment, "channel_polls", "twitch_poll_fictional", "TERMINATED", authorize, fetcher)],
    ["prediction creation", (authorize: () => Promise<boolean>, fetcher: typeof fetch) =>
      createPrediction(environment, "channel_polls", predictionEntry, authorize, fetcher)],
    ["prediction patch", (authorize: () => Promise<boolean>, fetcher: typeof fetch) =>
      patchPrediction(environment, "channel_polls", "twitch_prediction_fictional", { status: "LOCKED" }, authorize, fetcher)],
  ] as const)("blocks %s when authorization fails", async (_name, mutate) => {
    const authorize = vi.fn(() => Promise.resolve(false));
    const fetcher = vi.fn<typeof fetch>();

    await expect(mutate(authorize, fetcher)).resolves.toEqual({ ok: false, reason: "precondition_failed" });

    expect(authorize).toHaveBeenCalledOnce();
    expect(mocks.helixRequest).not.toHaveBeenCalled();
  });
});
