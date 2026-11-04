import { z } from "zod";

export const POLLS_MODULE_ID = "polls";
export const POLLS_ENTRY_MAXIMUM_COUNT = 200;

const POLL_LIMITS = {
  title: { minLength: 1, maxLength: 60 },
  choices: { minCount: 2, maxCount: 5 },
  choice: { minLength: 1, maxLength: 25 },
  durationSeconds: { min: 15, max: 1800 },
  channelPointsPerVote: { min: 1, max: 1_000_000 },
} as const;

const PREDICTION_LIMITS = {
  title: { minLength: 1, maxLength: 45 },
  choices: { minCount: 2, maxCount: 10 },
  choice: { minLength: 1, maxLength: 25 },
  durationSeconds: { min: 30, max: 1800 },
} as const;

export type PollsKind = "poll" | "prediction";
export type PollRunStatus = "active" | "completed" | "terminated" | "archived" | "unknown";
export type PredictionRunStatus = "active" | "locked" | "resolved" | "canceled" | "unknown";
export type PollsRunStatus = PollRunStatus | PredictionRunStatus;

const choiceSchema = z.string().trim().min(1).max(POLL_LIMITS.choice.maxLength);

const pollEntryInputSchema = z.object({
  kind: z.literal("poll"),
  title: z.string().trim().min(POLL_LIMITS.title.minLength).max(POLL_LIMITS.title.maxLength),
  choices: z.array(choiceSchema).min(POLL_LIMITS.choices.minCount).max(POLL_LIMITS.choices.maxCount),
  durationSeconds: z.number().int().min(POLL_LIMITS.durationSeconds.min).max(POLL_LIMITS.durationSeconds.max),
  channelPointsVotingEnabled: z.boolean(),
  channelPointsPerVote: z.number().int()
    .min(POLL_LIMITS.channelPointsPerVote.min)
    .max(POLL_LIMITS.channelPointsPerVote.max)
    .nullable(),
}).superRefine((entry, context) => {
  if (entry.channelPointsVotingEnabled && entry.channelPointsPerVote === null) {
    context.addIssue({ code: "custom", path: ["channelPointsPerVote"], message: "Required when channel-points voting is enabled." });
  }
  if (!entry.channelPointsVotingEnabled && entry.channelPointsPerVote !== null) {
    context.addIssue({ code: "custom", path: ["channelPointsPerVote"], message: "Must be null when channel-points voting is disabled." });
  }
});

const predictionEntryInputSchema = z.object({
  kind: z.literal("prediction"),
  title: z.string().trim().min(PREDICTION_LIMITS.title.minLength).max(PREDICTION_LIMITS.title.maxLength),
  choices: z.array(choiceSchema).min(PREDICTION_LIMITS.choices.minCount).max(PREDICTION_LIMITS.choices.maxCount),
  durationSeconds: z.number().int().min(PREDICTION_LIMITS.durationSeconds.min).max(PREDICTION_LIMITS.durationSeconds.max),
  channelPointsVotingEnabled: z.literal(false),
  channelPointsPerVote: z.null(),
});

export const pollsEntryInputSchema = z.discriminatedUnion("kind", [pollEntryInputSchema, predictionEntryInputSchema]);
export type PollsEntryInput = z.output<typeof pollsEntryInputSchema>;

export type PollsEntry = PollsEntryInput & {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
};

export interface PollsRunChoice {
  id: string;
  title: string;
  votes: number | null;
  users: number | null;
  channelPoints: number | null;
}

export interface PollsRun {
  id: string;
  kind: PollsKind;
  twitchId: string;
  entryId: string | null;
  source: "brobot" | "twitch";
  title: string;
  choices: PollsRunChoice[];
  status: PollsRunStatus;
  startedAt: string;
  endsAt: string | null;
  lockedAt: string | null;
  endedAt: string | null;
  winningChoiceId: string | null;
  refundDeadline: string | null;
  lastEventAt: string;
}

export type PollsHelixReason =
  | "success"
  | "already_active"
  | "not_eligible"
  | "invalid_input"
  | "rate_limited"
  | "network"
  | "unknown_status"
  | "invalid_response"
  | "not_connected"
  | "token_unavailable"
  | "scope_missing"
  | "revoked"
  | "refresh_failed"
  | "precondition_failed";

export type PollsHelixResult<Data> = { ok: true; data: Data } | { ok: false; reason: PollsHelixReason };

export interface HelixPoll {
  id: string;
  broadcaster_id: string;
  broadcaster_name: string;
  broadcaster_login: string;
  title: string;
  choices: readonly {
    id: string;
    title: string;
    votes: number;
    channel_points_votes: number;
    bits_votes: number;
  }[];
  bits_voting_enabled: boolean;
  bits_per_vote: number;
  channel_points_voting_enabled: boolean;
  channel_points_per_vote: number;
  status: "ACTIVE" | "COMPLETED" | "TERMINATED" | "ARCHIVED" | "MODERATED" | "INVALID";
  duration: number;
  started_at: string;
  ended_at: string | null;
}

export interface HelixPrediction {
  id: string;
  broadcaster_id: string;
  broadcaster_name: string;
  broadcaster_login: string;
  title: string;
  winning_outcome_id: string | null;
  outcomes: readonly {
    id: string;
    title: string;
    users: number;
    channel_points: number;
    top_predictors: readonly {
      user_name: string;
      user_login: string;
      user_id: string;
      channel_points_won: number | null;
      channel_points_used: number;
    }[] | null;
    color: "BLUE" | "PINK";
  }[];
  prediction_window: number;
  status: "ACTIVE" | "LOCKED" | "RESOLVED" | "CANCELED";
  created_at: string;
  ended_at: string | null;
  locked_at: string | null;
}
