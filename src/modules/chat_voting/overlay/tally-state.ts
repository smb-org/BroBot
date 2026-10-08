import type { BallotTermCount } from "../../contract";
import type { ChatVotingPreset, ChatVotingTextMode } from "../contracts";

export interface TallyState {
  pollId: string;
  openedAt?: string;
  closesAt?: string;
  requestedDurationSeconds?: number | null;
  title?: string | null;
  status?: "open" | "closed";
  labels?: readonly string[];
  preset?: ChatVotingPreset;
  optionCount?: number;
  textMode?: ChatVotingTextMode | null;
  counts: readonly number[];
  terms?: readonly BallotTermCount[];
  more?: number;
  termFilterReady?: boolean;
  revision: number;
  closedAt?: string | null;
}

const isTallyState = (value: unknown): value is TallyState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.pollId === "string" && Array.isArray(state.counts) &&
    state.counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    typeof state.revision === "number" && Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    (state.status === undefined || state.status === "open" || state.status === "closed") &&
    (state.openedAt === undefined || typeof state.openedAt === "string" && Number.isFinite(Date.parse(state.openedAt))) &&
    (state.closesAt === undefined || typeof state.closesAt === "string" && Number.isFinite(Date.parse(state.closesAt))) &&
    (state.requestedDurationSeconds === undefined || state.requestedDurationSeconds === null ||
      typeof state.requestedDurationSeconds === "number" && Number.isSafeInteger(state.requestedDurationSeconds) && state.requestedDurationSeconds > 0) &&
    (state.title === undefined || state.title === null || typeof state.title === "string" && Array.from(state.title).length <= 80) &&
    (state.labels === undefined || Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")) &&
    (state.preset === undefined || state.preset === "yes_no" || state.preset === "scale_5" || state.preset === "options_n" ||
      state.preset === "digit_01" || state.preset === "digit_12" || state.preset === "free_text") &&
    (state.optionCount === undefined || typeof state.optionCount === "number" && Number.isInteger(state.optionCount) && state.optionCount >= 0 && state.optionCount <= 9) &&
    (state.textMode === undefined || state.textMode === null || state.textMode === "first_word" || state.textMode === "whole_message") &&
    (state.terms === undefined || Array.isArray(state.terms) && state.terms.every((entry) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof Reflect.get(entry, "term") === "string" && Array.from(Reflect.get(entry, "term") as string).length <= 25 &&
      Number.isSafeInteger(Reflect.get(entry, "count")) && (Reflect.get(entry, "count") as number) > 0 &&
      typeof Reflect.get(entry, "approved") === "boolean")) &&
    (state.more === undefined || typeof state.more === "number" && Number.isSafeInteger(state.more) && state.more >= 0) &&
    (state.termFilterReady === undefined || typeof state.termFilterReady === "boolean") &&
    (state.closedAt === undefined || state.closedAt === null || typeof state.closedAt === "string");
};

const isNewerPoll = (incoming: TallyState, previous: TallyState): boolean => {
  if (incoming.openedAt === undefined || previous.openedAt === undefined) return false;
  const incomingStart = Date.parse(incoming.openedAt);
  const previousStart = Date.parse(previous.openedAt);
  return Number.isFinite(incomingStart) && Number.isFinite(previousStart) && incomingStart > previousStart;
};

/** Merges partial realtime tally messages; bootstrap state is supplied directly by the canvas. */
export const mergeTallyState = (previous: TallyState | null, incoming: TallyState | null): TallyState | null => {
  if (incoming === null) return null;
  if (previous === null) return incoming;
  if (incoming.pollId !== previous.pollId) {
    return isNewerPoll(incoming, previous) ? incoming : previous;
  }
  if (incoming.status === "closed") {
    return { ...previous, ...incoming };
  }
  if (previous.status === "closed") return previous;
  if (incoming.revision < previous.revision) return previous;
  return { ...previous, ...incoming };
};

/** Applies the tally reducer to arbitrary JSON realtime state. */
export const mergeTallyRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (!isTallyState(incoming) || current !== null && !isTallyState(current)) return incoming;
  return (mergeTallyState(current, incoming) ?? incoming) as unknown as Readonly<Record<string, unknown>>;
};
