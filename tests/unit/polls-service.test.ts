import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withBroadcasterToken: vi.fn(),
}));

vi.mock("../../src/worker/auth/broadcaster-token", () => ({
  withBroadcasterToken: mocks.withBroadcasterToken,
}));

import { reconcile, resolvePredictionRun, startEntry } from "../../src/modules/polls/service";
import { createPollsRepository } from "../../src/modules/polls/repository";
import { TestD1Database } from "./test-d1";

const channelId = "channel_polls";
const now = "2026-11-04T12:00:00.000Z";
const prediction = {
  id: "twitch_prediction_demo",
  broadcaster_id: channelId,
  title: "Fictional prediction",
  outcomes: [
    { id: "outcome_first", title: "First", users: 4, channel_points: 120 },
    { id: "outcome_second", title: "Second", users: 1, channel_points: 20 },
  ],
  started_at: now,
  locks_at: "2026-11-04T12:02:00.000Z",
  locked_at: null,
  ended_at: null,
  winning_outcome_id: null,
  status: "ACTIVE",
};

const jsonResponse = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});

const installFetch = (handler: (url: URL, method: string) => Response) => {
  const fetcher = vi.fn<typeof fetch>((input, init) => Promise.resolve(handler(new URL(input instanceof Request ? input.url : input.toString()), init?.method ?? "GET")));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

describe("polls service", () => {
  let database: TestD1Database;
  let repository: ReturnType<typeof createPollsRepository>;
  const environment = { TWITCH_CLIENT_ID: "fictional-client" } as Env;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.withBroadcasterToken.mockImplementation(async (
      _environment: Env,
      _broadcasterId: string,
      _scopes: string[],
      request: (accessToken: string) => Promise<unknown>,
    ) => {
      const result = await request("broadcaster-token") as { ok: boolean; status?: number; data?: unknown };
      return result.ok ? { kind: "ok", value: result.data } : { kind: "http_error", result };
    });
    database = new TestD1Database();
    database.sqlite.prepare(
      `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(channelId, "polls_demo", "Polls demo", now, now);
    repository = createPollsRepository(database as unknown as D1Database);
    environment.DB = database as unknown as D1Database;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  it("closes a prediction from the successful PATCH response when its end event is lost", async () => {
    const run = await repository.upsertRunSnapshot(channelId, {
      kind: "prediction", twitchId: prediction.id, title: prediction.title,
      choices: prediction.outcomes.map((outcome) => ({
        id: outcome.id, title: outcome.title, votes: null, users: outcome.users, channelPoints: outcome.channel_points,
      })),
      status: "active", startedAt: now, endsAt: prediction.locks_at, lockedAt: null, endedAt: null,
      winningChoiceId: null, observedAt: now, terminalPayload: null, source: "twitch",
    });
    expect(run).toBe("inserted");
    installFetch((_url, method) => method === "PATCH"
      ? jsonResponse({ data: [{
        ...prediction, status: "RESOLVED", ended_at: "2026-11-04T12:03:00.000Z", winning_outcome_id: "outcome_first",
      }] })
      : jsonResponse({ data: [{ ...prediction, status: "LOCKED", locked_at: prediction.locks_at }] }));

    const result = await resolvePredictionRun(environment, channelId, await getRunId(), "outcome_first");

    expect(result).toMatchObject({ ok: true, run: { status: "resolved", winningChoiceId: "outcome_first" } });
  });

  it("resolves a prediction first discovered by reconciliation GET", async () => {
    installFetch((url, method) => url.pathname.endsWith("/predictions")
      ? jsonResponse({ data: [method === "PATCH"
        ? { ...prediction, status: "RESOLVED", ended_at: "2026-11-04T12:03:00.000Z", winning_outcome_id: "outcome_first" }
        : { ...prediction, status: "LOCKED", locked_at: prediction.locks_at }] })
      : jsonResponse({ data: [] }));
    await reconcile(environment, channelId, now, { force: true });
    const run = await repository.findRunByTwitchId(channelId, "prediction", prediction.id);
    if (run === null) throw new Error("Reconciliation did not insert the prediction.");
    await expect(resolvePredictionRun(environment, channelId, run.id, "outcome_first"))
      .resolves.toMatchObject({ ok: true, run: { status: "resolved", winningChoiceId: "outcome_first" } });
  });

  it("reconciles after Twitch rejects a start because a poll is already active", async () => {
    const entry = await repository.createEntry(channelId, {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (entry === "limit_reached") throw new Error("Unexpected entry limit.");
    const fetcher = installFetch((url, method) => {
      if (method === "POST") return jsonResponse({ message: "A poll is already active for this broadcaster." }, 400);
      if (url.pathname.endsWith("/polls")) return jsonResponse({ data: [{
        id: "twitch_poll_foreign", title: "Foreign poll",
        choices: [{ id: "choice_first", title: "First", votes: 0 }, { id: "choice_second", title: "Second", votes: 0 }],
        started_at: now, ends_at: "2026-11-04T12:01:00.000Z", ended_at: null, status: "ACTIVE",
      }] });
      return jsonResponse({ data: [] });
    });

    await expect(startEntry(environment, channelId, entry.id, "2026-11-04T12:00:01.000Z"))
      .resolves.toEqual({ ok: false, reason: "already_active" });
    expect(fetcher).toHaveBeenCalled();
    await expect(repository.findRunByTwitchId(channelId, "poll", "twitch_poll_foreign"))
      .resolves.toMatchObject({ source: "twitch", status: "active" });
  });

  it("marks an open run unknown when the by-ID Helix answer omits it", async () => {
    const inserted = await repository.upsertRunSnapshot(channelId, {
      kind: "prediction", twitchId: prediction.id, title: prediction.title, choices: [], status: "active",
      startedAt: now, endsAt: null, lockedAt: null, endedAt: null, winningChoiceId: null,
      observedAt: now, terminalPayload: null,
    });
    expect(inserted).toBe("inserted");
    const fetcher = installFetch(() => jsonResponse({ data: [] }));
    await reconcile(environment, channelId, "2026-11-04T12:00:20.000Z", { force: true });
    expect(fetcher).toHaveBeenCalledTimes(3);

    await expect(repository.findRunByTwitchId(channelId, "prediction", prediction.id))
      .resolves.toMatchObject({ status: "unknown" });
  });

  it("skips reconciliation while the saved timestamp is younger than fifteen seconds", async () => {
    await database.prepare(
      "INSERT INTO polls_reconcile_state (channel_id, last_reconciled_at) VALUES (?, ?)",
    ).bind(channelId, now).run();
    const fetcher = installFetch(() => jsonResponse({ data: [] }));

    await reconcile(environment, channelId, "2026-11-04T12:00:14.999Z", { force: false });

    expect(fetcher).not.toHaveBeenCalled();
  });

  const getRunId = async (): Promise<string> => {
    const run = await repository.findRunByTwitchId(channelId, "prediction", prediction.id);
    if (run === null) throw new Error("Prediction was not stored.");
    return run.id;
  };
});
