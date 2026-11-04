import { z } from "zod";

import type {
  HelixPoll,
  HelixPrediction,
  PollsEntryInput,
  PollsHelixReason,
  PollsHelixResult,
} from "../../modules/polls/contracts";
import type { HelixResult } from "../../modules/contract";
import { withBroadcasterToken, type BroadcasterTokenResult } from "../auth/broadcaster-token";
import { helixRequest } from "./helix";

const POLLS_URL = "https://api.twitch.tv/helix/polls";
const PREDICTIONS_URL = "https://api.twitch.tv/helix/predictions";

const pollSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  choices: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    votes: z.number().int().nonnegative().optional(),
    channel_points_votes: z.number().int().nonnegative().optional(),
  })),
  status: z.string(),
  started_at: z.string(),
  ends_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  duration: z.number().int().nonnegative().optional(),
});

const predictionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  outcomes: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    users: z.number().int().nonnegative().optional(),
    channel_points: z.number().int().nonnegative().optional(),
  })),
  status: z.string(),
  started_at: z.string(),
  locks_at: z.string().nullable().optional(),
  locked_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  winning_outcome_id: z.string().nullable().optional(),
});

const pollsEnvelopeSchema = z.object({ data: z.array(pollSchema) });
const predictionsEnvelopeSchema = z.object({ data: z.array(predictionSchema) });

const activeDescription = /\b(active|already)\b.*\b(poll|prediction)\b|\b(poll|prediction)\b.*\b(active|already)\b/iu;

/** Maps the shared Helix status table to poll-specific errors. */
export const mapPollsHttpStatus = (status: number | null, message: string | null = null): PollsHelixReason => {
  if (status === null) return "network";
  if (status >= 200 && status < 300) return "success";
  if (status === 400) return activeDescription.test(message ?? "") ? "already_active" : "invalid_input";
  if (status === 403) return "not_eligible";
  if (status === 429) return "rate_limited";
  return "unknown_status";
};

type FailedTokenResult<Data> = Exclude<BroadcasterTokenResult<Data>, { kind: "ok" }>;

const mapTokenFailure = <Data>(result: FailedTokenResult<Data>): PollsHelixReason => {
  if (result.kind === "http_error") {
    if (result.result.reason === "invalid_response") return "invalid_response";
    return mapPollsHttpStatus(result.result.status, result.result.message);
  }
  if (result.kind === "request_failed") return "network";
  return result.kind;
};

interface RequestSpec<Data> {
  environment: Env;
  broadcasterId: string;
  scope: "channel:manage:polls" | "channel:manage:predictions";
  url: string;
  method?: "GET" | "POST" | "PATCH";
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  schema: z.ZodType<{ data: Data }>;
  fetcher: typeof fetch;
}

const requestWithBroadcasterToken = async <Data>(spec: RequestSpec<Data>): Promise<PollsHelixResult<Data>> => {
  const result = await withBroadcasterToken<{ data: Data }>(
    spec.environment,
    spec.broadcasterId,
    [spec.scope],
    async (accessToken): Promise<HelixResult<{ data: Data }>> => helixRequest({
      url: spec.url,
      ...(spec.method === undefined ? {} : { method: spec.method }),
      ...(spec.query === undefined ? {} : { query: spec.query }),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      clientId: spec.environment.TWITCH_CLIENT_ID,
      accessToken,
      schema: spec.schema,
      fetcher: spec.fetcher,
    }),
    { fetcher: spec.fetcher },
  );
  return result.kind === "ok"
    ? { ok: true, data: result.value.data }
    : { ok: false, reason: mapTokenFailure(result) };
};

const urlWithIds = (endpoint: string, ids: readonly string[]): string => {
  const url = new URL(endpoint);
  for (const id of ids) url.searchParams.append("id", id);
  return url.toString();
};

export const createPoll = (
  environment: Env,
  broadcasterId: string,
  entry: PollsEntryInput,
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPoll[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:polls",
  url: POLLS_URL,
  method: "POST",
  body: {
    broadcaster_id: broadcasterId,
    title: entry.title,
    choices: entry.choices.map((title) => ({ title })),
    duration: entry.durationSeconds,
    channel_points_voting_enabled: entry.channelPointsVotingEnabled,
    channel_points_per_vote: entry.channelPointsPerVote,
  },
  schema: pollsEnvelopeSchema,
  fetcher,
});

export const endPoll = (
  environment: Env,
  broadcasterId: string,
  twitchId: string,
  status: "TERMINATED" | "ARCHIVED",
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPoll[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:polls",
  url: POLLS_URL,
  method: "PATCH",
  body: { broadcaster_id: broadcasterId, id: twitchId, status },
  schema: pollsEnvelopeSchema,
  fetcher,
});

export const getPolls = (
  environment: Env,
  broadcasterId: string,
  ids: string[],
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPoll[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:polls",
  url: urlWithIds(POLLS_URL, ids),
  query: { broadcaster_id: broadcasterId, ...(ids.length === 0 ? { first: "5" } : {}) },
  schema: pollsEnvelopeSchema,
  fetcher,
});

export const createPrediction = (
  environment: Env,
  broadcasterId: string,
  entry: PollsEntryInput,
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPrediction[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:predictions",
  url: PREDICTIONS_URL,
  method: "POST",
  body: {
    broadcaster_id: broadcasterId,
    title: entry.title,
    outcomes: entry.choices.map((title) => ({ title })),
    prediction_window: entry.durationSeconds,
  },
  schema: predictionsEnvelopeSchema,
  fetcher,
});

type PredictionChange =
  | { status: "LOCKED" }
  | { status: "RESOLVED"; winningOutcomeId: string }
  | { status: "CANCELED" };

export const patchPrediction = (
  environment: Env,
  broadcasterId: string,
  twitchId: string,
  change: PredictionChange,
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPrediction[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:predictions",
  url: PREDICTIONS_URL,
  method: "PATCH",
  body: {
    broadcaster_id: broadcasterId,
    id: twitchId,
    status: change.status,
    ...(change.status === "RESOLVED" ? { winning_outcome_id: change.winningOutcomeId } : {}),
  },
  schema: predictionsEnvelopeSchema,
  fetcher,
});

export const getPredictions = (
  environment: Env,
  broadcasterId: string,
  ids: string[],
  fetcher: typeof fetch = fetch,
): Promise<PollsHelixResult<HelixPrediction[]>> => requestWithBroadcasterToken({
  environment,
  broadcasterId,
  scope: "channel:manage:predictions",
  url: urlWithIds(PREDICTIONS_URL, ids),
  query: { broadcaster_id: broadcasterId, ...(ids.length === 0 ? { first: "5" } : {}) },
  schema: predictionsEnvelopeSchema,
  fetcher,
});
