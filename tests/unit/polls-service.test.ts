import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withBroadcasterToken: vi.fn(),
}));

vi.mock("../../src/worker/auth/broadcaster-token", () => ({
  withBroadcasterToken: mocks.withBroadcasterToken,
}));

import { processPollsEvent, reconcile, resolvePredictionRun, startEntry } from "../../src/modules/polls/service";
import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { createPollsRepository } from "../../src/modules/polls/repository";
import { TestD1Database } from "./test-d1";

const channelId = "channel_polls";
const now = "2026-11-04T12:00:00.000Z";
const prediction = {
  id: "twitch_prediction_fictional",
  broadcaster_id: channelId,
  broadcaster_name: "Polls Demo",
  broadcaster_login: "polls_demo",
  title: "Fictional prediction",
  outcomes: [
    { id: "outcome_first", title: "First", users: 4, channel_points: 120, top_predictors: null, color: "BLUE" },
    { id: "outcome_second", title: "Second", users: 1, channel_points: 20, top_predictors: null, color: "PINK" },
  ],
  winning_outcome_id: null,
  prediction_window: 120,
  created_at: now,
  status: "ACTIVE",
  ended_at: null,
  locked_at: null,
};

const helixPoll = {
  id: "twitch_poll_fictional",
  broadcaster_id: channelId,
  broadcaster_name: "Polls Demo",
  broadcaster_login: "polls_demo",
  title: "Fictional poll",
  choices: [
    { id: "choice_first", title: "First", votes: 3, channel_points_votes: 60, bits_votes: 0 },
    { id: "choice_second", title: "Second", votes: 1, channel_points_votes: 20, bits_votes: 0 },
  ],
  bits_voting_enabled: false,
  bits_per_vote: 0,
  channel_points_voting_enabled: false,
  channel_points_per_vote: 0,
  status: "ACTIVE",
  duration: 60,
  started_at: now,
  ended_at: null,
};

const authorized = (): Promise<boolean> => Promise.resolve(true);

const jsonResponse = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});

const installFetch = (handler: (url: URL, method: string) => Response | Promise<Response>) => {
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
      dependencies?: { beforeCall?: () => Promise<boolean> },
    ) => {
      if (dependencies?.beforeCall !== undefined && !await dependencies.beforeCall()) {
        return { kind: "precondition_failed" };
      }
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
      status: "active", startedAt: prediction.created_at, endsAt: "2026-11-04T12:02:00.000Z", lockedAt: null, endedAt: null,
      winningChoiceId: null, observedAt: now, terminalPayload: null, source: "twitch",
    });
    expect(run).toBe("inserted");
    installFetch((_url, method) => method === "PATCH"
      ? jsonResponse({ data: [{
        ...prediction, status: "RESOLVED", ended_at: "2026-11-04T12:03:00.000Z", winning_outcome_id: "outcome_first",
      }] })
      : jsonResponse({ data: [{ ...prediction, status: "LOCKED", locked_at: "2026-11-04T12:02:00.000Z" }] }));

    const result = await resolvePredictionRun(environment, channelId, await getRunId(), "outcome_first", authorized);

    expect(result).toMatchObject({ ok: true, run: { status: "resolved", winningChoiceId: "outcome_first" } });
  });

  it("uses Helix prediction creation time for its start, lock, and refund deadlines", async () => {
    const created = await repository.createEntry(channelId, {
      kind: "prediction", title: "Fictional prediction", choices: ["First", "Second"], durationSeconds: 120,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (created === "limit_reached") throw new Error("Unexpected entry limit.");
    installFetch((_url, method) => method === "POST"
      ? jsonResponse({ data: [prediction] })
      : jsonResponse({ data: [] }));

    const result = await startEntry(environment, channelId, created.id, "2026-11-04T12:00:03.000Z", authorized);

    expect(result).toMatchObject({
      ok: true,
      run: {
        startedAt: "2026-11-04T12:00:00.000Z",
        endsAt: "2026-11-04T12:02:00.000Z",
        refundDeadline: "2026-11-05T12:00:00.000Z",
      },
    });
  });

  it("resolves a prediction first discovered by reconciliation GET", async () => {
    installFetch((url, method) => url.pathname.endsWith("/predictions")
      ? jsonResponse({ data: [method === "PATCH"
        ? { ...prediction, status: "RESOLVED", ended_at: "2026-11-04T12:03:00.000Z", winning_outcome_id: "outcome_first" }
        : { ...prediction, status: "LOCKED", locked_at: "2026-11-04T12:02:00.000Z" }] })
      : jsonResponse({ data: [] }));
    await reconcile(environment, channelId, now, { force: true });
    const run = await repository.findRunByTwitchId(channelId, "prediction", prediction.id);
    if (run === null) throw new Error("Reconciliation did not insert the prediction.");
    await expect(resolvePredictionRun(environment, channelId, run.id, "outcome_first", authorized))
      .resolves.toMatchObject({ ok: true, run: { status: "resolved", winningChoiceId: "outcome_first" } });
  });

  it("associates a BroBot entry when EventSub begin arrives before the Helix create response", async () => {
    const created = await repository.createEntry(channelId, {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (created === "limit_reached") throw new Error("Unexpected entry limit.");
    const eventTimestamp = "2026-11-04T12:00:05.000Z";
    const context = { DB: database as unknown as D1Database } as ModuleExecutionContext;
    installFetch(async (_url, method) => {
      if (method !== "POST") return jsonResponse({ data: [] });
      const event: ModuleEvent = {
        channelId,
        subscriptionType: "channel.poll.begin",
        triggerId: "event_poll_begin_fictional",
        payload: {
          id: helixPoll.id,
          broadcaster_user_id: channelId,
          title: helixPoll.title,
          choices: helixPoll.choices,
          started_at: helixPoll.started_at,
          ends_at: "2026-11-04T12:01:00.000Z",
        },
        settings: {},
        receivedAt: eventTimestamp,
        eventSubTimestamp: eventTimestamp,
        actor: null,
        chatStatus: null,
      };
      await processPollsEvent(event, context);
      return jsonResponse({ data: [helixPoll] });
    });

    const result = await startEntry(environment, channelId, created.id, "2026-11-04T12:00:01.000Z", authorized);

    expect(result).toMatchObject({
      ok: true,
      run: {
        twitchId: helixPoll.id,
        status: "active",
        source: "brobot",
        entryId: created.id,
        lastEventAt: eventTimestamp,
      },
    });
    await expect(repository.getEntry(channelId, created.id)).resolves.toMatchObject({
      lastStartedAt: "2026-11-04T12:00:01.000Z",
    });
  });

  it("stores the run without an entry when the entry is deleted while Helix creates it", async () => {
    const created = await repository.createEntry(channelId, {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (created === "limit_reached") throw new Error("Unexpected entry limit.");
    installFetch(async (_url, method) => {
      if (method === "POST") await repository.deleteEntry(channelId, created.id);
      return jsonResponse({ data: method === "POST" ? [helixPoll] : [] });
    });

    await expect(startEntry(environment, channelId, created.id, "2026-11-04T12:00:01.000Z", authorized))
      .resolves.toMatchObject({ ok: true, run: { twitchId: helixPoll.id, entryId: null, source: "brobot" } });
  });

  it("accepts Helix responses that omit nullable fields", async () => {
    // JSON.stringify drops undefined, so the key is absent on the wire.
    const omittedPoll = { ...helixPoll, ended_at: undefined };
    const omittedPrediction = {
      id: prediction.id, broadcaster_id: channelId, broadcaster_name: "Polls Demo", broadcaster_login: "polls_demo",
      title: prediction.title,
      outcomes: [{ id: "outcome_first", title: "First", users: 0, channel_points: 0, color: "BLUE" }],
      prediction_window: 120, status: "ACTIVE", created_at: now,
    };
    installFetch((url) => jsonResponse({ data: [url.pathname.endsWith("/predictions") ? omittedPrediction : omittedPoll] }));

    await reconcile(environment, channelId, "2026-11-04T12:00:20.000Z", { force: true });

    await expect(repository.findRunByTwitchId(channelId, "poll", helixPoll.id))
      .resolves.toMatchObject({ status: "active", endedAt: null });
    await expect(repository.findRunByTwitchId(channelId, "prediction", prediction.id))
      .resolves.toMatchObject({ status: "active", endedAt: null, lockedAt: null, winningChoiceId: null });
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
        ...helixPoll,
        id: "twitch_poll_other_fictional",
        title: "Another fictional poll",
        started_at: now,
      }] });
      return jsonResponse({ data: [] });
    });

    await expect(startEntry(environment, channelId, entry.id, "2026-11-04T12:00:01.000Z", authorized))
      .resolves.toEqual({ ok: false, reason: "already_active" });
    expect(fetcher).toHaveBeenCalled();
    await expect(repository.findRunByTwitchId(channelId, "poll", "twitch_poll_other_fictional"))
      .resolves.toMatchObject({ source: "twitch", status: "active" });
  });

  it("does not let an unknown poll block a start", async () => {
    const entry = await repository.createEntry(channelId, {
      kind: "poll", title: "Fictional poll", choices: ["First", "Second"], durationSeconds: 60,
      channelPointsVotingEnabled: false, channelPointsPerVote: null,
    }, now);
    if (entry === "limit_reached") throw new Error("Unexpected entry limit.");
    await repository.upsertRunSnapshot(channelId, {
      kind: "poll", twitchId: "twitch_poll_stale", title: "Stale poll", choices: [], status: "unknown",
      startedAt: now, endsAt: null, lockedAt: null, endedAt: null, winningChoiceId: null,
      observedAt: now, terminalPayload: null,
    });
    const fetcher = installFetch((_url, method) => jsonResponse({ data: method === "POST" ? [helixPoll] : [] }));

    await expect(startEntry(environment, channelId, entry.id, "2026-11-04T12:00:01.000Z", authorized))
      .resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
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
