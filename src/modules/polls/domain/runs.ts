import type {
  HelixPoll,
  HelixPrediction,
  PollRunStatus,
  PollsKind,
  PollsRunChoice,
  PollsRunStatus,
  PredictionRunStatus,
} from "../contracts";

export interface RunSnapshot {
  kind: PollsKind;
  twitchId: string;
  title: string;
  choices: PollsRunChoice[];
  status: PollsRunStatus;
  startedAt: string;
  endsAt: string | null;
  lockedAt: string | null;
  endedAt: string | null;
  winningChoiceId: string | null;
  observedAt: string;
  terminalPayload: unknown;
  entryId?: string | null;
  source?: "brobot" | "twitch";
}

interface EventSubEnvelope {
  id: string;
  title: string;
  startedAt: string;
  choices: PollsRunChoice[];
  endsAt: string | null;
  lockedAt: string | null;
  endedAt: string | null;
  winningChoiceId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const timestamp = (value: unknown): string | null => {
  const parsed = nonEmptyString(value);
  return parsed !== null && Number.isFinite(Date.parse(parsed)) ? new Date(parsed).toISOString() : null;
};

const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

const choiceRows = (
  value: unknown,
  kind: PollsKind,
): PollsRunChoice[] | null => {
  if (!Array.isArray(value)) return null;
  const choices: PollsRunChoice[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = nonEmptyString(item.id);
    const title = nonEmptyString(item.title);
    if (id === null || title === null) return null;
    choices.push({
      id,
      title,
      votes: kind === "poll" ? count(item.votes) : null,
      users: kind === "prediction" ? count(item.users) : null,
      channelPoints: kind === "prediction" ? count(item.channel_points) : count(item.channel_points_votes),
    });
  }
  return choices;
};

const PAYLOAD_SCALARS = ["id", "title", "status", "started_at", "ended_at", "locked_at", "locks_at", "ends_at", "winning_outcome_id"] as const;
const PAYLOAD_CHOICE_FIELDS = ["id", "title", "color", "votes", "channel_points_votes", "bits_votes", "users", "channel_points"] as const;

/** Keeps only aggregates: no top predictors, no viewer or broadcaster identities. */
const aggregatePayload = (payload: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const pick = (source: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  const result = pick(payload, PAYLOAD_SCALARS);
  for (const key of ["choices", "outcomes"]) {
    const rows = payload[key];
    if (Array.isArray(rows)) {
      result[key] = rows.filter(isRecord).map((row) => pick(row, PAYLOAD_CHOICE_FIELDS));
    }
  }
  return result;
};

const eventSubEnvelope =(payload: Readonly<Record<string, unknown>>, kind: PollsKind): EventSubEnvelope | null => {
  const id = nonEmptyString(payload.id);
  const title = nonEmptyString(payload.title);
  const startedAt = timestamp(payload.started_at);
  const choices = choiceRows(kind === "poll" ? payload.choices : payload.outcomes, kind);
  if (id === null || title === null || startedAt === null || choices === null) return null;
  return {
    id,
    title,
    startedAt,
    choices,
    endsAt: timestamp(kind === "poll" ? payload.ends_at : payload.locks_at),
    lockedAt: timestamp(payload.locked_at),
    endedAt: timestamp(payload.ended_at),
    winningChoiceId: nonEmptyString(payload.winning_outcome_id),
  };
};

const pollTerminalStatus = (value: unknown): PollRunStatus => {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "completed": return "completed";
    case "archived": return "archived";
    case "terminated":
    case "moderated":
    case "invalid": return "terminated";
    default: return "completed";
  }
};

const predictionTerminalStatus = (value: unknown, winningChoiceId: string | null): PredictionRunStatus => {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "resolved": return "resolved";
    case "canceled": return "canceled";
    default: return winningChoiceId === null ? "canceled" : "resolved";
  }
};

const POLLS_EVENTSUB_TYPES = new Set([
  "channel.poll.begin",
  "channel.poll.progress",
  "channel.poll.end",
  "channel.prediction.begin",
  "channel.prediction.progress",
  "channel.prediction.lock",
  "channel.prediction.end",
]);

const isPollTerminal = (status: PollsRunStatus): status is Exclude<PollRunStatus, "active" | "unknown"> =>
  status === "completed" || status === "terminated" || status === "archived";

const isPredictionTerminal = (status: PollsRunStatus): status is Exclude<PredictionRunStatus, "active" | "locked" | "unknown"> =>
  status === "resolved" || status === "canceled";

const statusRank = (kind: PollsKind, status: PollsRunStatus): 0 | 1 | 2 | -1 => {
  if (status === "unknown") return -1;
  if (status === "locked") return 1;
  if (kind === "poll") return isPollTerminal(status) ? 2 : 0;
  return isPredictionTerminal(status) ? 2 : 0;
};

export const shouldApplySnapshot = (
  current: { status: PollsRunStatus; lastEventAt: string } | null,
  next: RunSnapshot,
): boolean => {
  if (current === null) return true;
  const currentRank = statusRank(next.kind, current.status);
  const nextRank = statusRank(next.kind, next.status);
  if (currentRank === 2) return false;
  if (nextRank > currentRank) return true;
  return nextRank === currentRank &&next.observedAt >= current.lastEventAt;
};

export const snapshotFromEventSub = (
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
  receivedAt: string,
): RunSnapshot | null => {
  if (!POLLS_EVENTSUB_TYPES.has(subscriptionType)) return null;
  const isPoll = subscriptionType.startsWith("channel.poll.");
  const isPrediction = subscriptionType.startsWith("channel.prediction.");
  if (!isPoll && !isPrediction) return null;
  const kind: PollsKind = isPoll ? "poll" : "prediction";
  const isEnd = subscriptionType === `channel.${kind}.end`;
  const envelope = eventSubEnvelope(payload, kind);
  if (envelope === null) return null;

  let status: PollsRunStatus;
  if (kind === "poll") {
    status = isEnd ? pollTerminalStatus(payload.status) : "active";
  } else if (subscriptionType === "channel.prediction.lock") {
    status = "locked";
  } else if (isEnd) {
    status = predictionTerminalStatus(payload.status, envelope.winningChoiceId);
  } else {
    status = "active";
  }

  return {
    kind,
    twitchId: envelope.id,
    title: envelope.title,
    choices: envelope.choices,
    status,
    startedAt: envelope.startedAt,
    endsAt: envelope.endsAt,
    lockedAt: envelope.lockedAt,
    endedAt: envelope.endedAt,
    winningChoiceId: envelope.winningChoiceId,
    observedAt: timestamp(receivedAt) ?? receivedAt,
    terminalPayload: isEnd && (kind === "poll" ? isPollTerminal(status) : isPredictionTerminal(status))
      ? aggregatePayload(payload)
      : null,
  };
};

const pollStatusFromHelix = (value: string): PollRunStatus => {
  switch (value.toUpperCase()) {
    case "ACTIVE": return "active";
    case "COMPLETED": return "completed";
    case "TERMINATED":
    case "MODERATED":
    case "INVALID": return "terminated";
    case "ARCHIVED": return "archived";
    default: return "unknown";
  }
};

const predictionStatusFromHelix = (value: string): PredictionRunStatus => {
  switch (value.toUpperCase()) {
    case "ACTIVE": return "active";
    case "LOCKED": return "locked";
    case "RESOLVED": return "resolved";
    case "CANCELED": return "canceled";
    default: return "unknown";
  }
};

export type HelixPollSnapshotData = HelixPoll;
export type HelixPredictionSnapshotData = HelixPrediction;

const helixChoices = (
  choices: readonly {
    id: string;
    title: string;
    votes?: number | undefined;
    users?: number | undefined;
    channel_points?: number | undefined;
    channel_points_votes?: number | undefined;
  }[],
  kind: PollsKind,
): PollsRunChoice[] => choices.map((choice) => ({
  id: choice.id,
  title: choice.title,
  votes: kind === "poll" ? count(choice.votes) : null,
  users: kind === "prediction" ? count(choice.users) : null,
  channelPoints: kind === "prediction" ? count(choice.channel_points) : count(choice.channel_points_votes),
}));

export const snapshotFromHelixPoll = (data: HelixPollSnapshotData, observedAt: string): RunSnapshot => {
  const status = pollStatusFromHelix(data.status);
  const startedAt = timestamp(data.started_at) ?? observedAt;
  const durationEnd = Number.isSafeInteger(data.duration) && data.duration >= 0
    ? new Date(Date.parse(startedAt) + data.duration * 1_000).toISOString()
    : null;
  return {
    kind: "poll",
    twitchId: data.id,
    title: data.title,
    choices: helixChoices(data.choices, "poll"),
    status,
    startedAt,
    endsAt: durationEnd,
    lockedAt: null,
    endedAt: timestamp(data.ended_at),
    winningChoiceId: null,
    observedAt,
    terminalPayload: null,
  };
};

export const snapshotFromHelixPrediction = (data: HelixPredictionSnapshotData, observedAt: string): RunSnapshot => {
  const startedAt = timestamp(data.created_at) ?? observedAt;
  const endsAt = Number.isSafeInteger(data.prediction_window) && data.prediction_window >= 0
    ? new Date(Date.parse(startedAt) + data.prediction_window * 1_000).toISOString()
    : null;
  return {
    kind: "prediction",
    twitchId: data.id,
    title: data.title,
    choices: helixChoices(data.outcomes, "prediction"),
    status: predictionStatusFromHelix(data.status),
    startedAt,
    endsAt,
    // EventSub has absolute locks_at timestamps; Helix predictions have a relative prediction_window.
    lockedAt: timestamp(data.locked_at),
    endedAt: timestamp(data.ended_at),
    winningChoiceId: nonEmptyString(data.winning_outcome_id),
    observedAt,
    terminalPayload: null,
  };
};
