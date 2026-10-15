import type { BallotTermCount } from "../../contract";
import { chatVotingKindForPreset, chatVotingPresetForKind } from "../contracts";
import type { ChatVotingKind, ChatVotingPreset, ChatVotingTextMode } from "../contracts";

export interface TallyState {
  pollId: string;
  openedAt?: string;
  closesAt?: string;
  requestedDurationSeconds?: number | null;
  title?: string | null;
  status?: "open" | "closing" | "closed";
  labels?: readonly string[];
  kind?: ChatVotingKind;
  preset?: ChatVotingPreset;
  optionCount?: number;
  textMode?: ChatVotingTextMode | null;
  counts: readonly number[];
  terms?: readonly BallotTermCount[];
  more?: number;
  termFilterReady?: boolean;
  revision: number;
  deadlineRevision?: number;
  closedAt?: string | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const parseTallyState = (value: unknown): TallyState | null => {
  const state = record(value);
  if (state === null || typeof state.pollId !== "string" || !Array.isArray(state.counts) ||
      !state.counts.every(isNonNegativeInteger) ||
      !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return null;
  const labels = Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")
    ? state.labels
    : undefined;
  const terms = Array.isArray(state.terms) && state.terms.every((entry) => {
    const term = record(entry);
    return term !== null && typeof term.term === "string" && Array.from(term.term).length <= 25 &&
      isNonNegativeInteger(term.count) && term.count > 0 && typeof term.approved === "boolean";
  }) ? state.terms as TallyState["terms"] : undefined;
  const validPreset = state.preset === "yes_no" || state.preset === "scale_5" || state.preset === "options_n" ||
    state.preset === "digit_01" || state.preset === "digit_12" || state.preset === "free_text";
  const validKind = state.kind === "yes_no" || state.kind === "options" || state.kind === "free_text";
  const storedPreset = validPreset ? state.preset as ChatVotingPreset : undefined;
  const kind: ChatVotingKind | undefined = validKind ? state.kind as ChatVotingKind
    : storedPreset === undefined ? undefined : chatVotingKindForPreset(storedPreset);
  const preset = storedPreset ?? (kind === undefined ? undefined : chatVotingPresetForKind(kind));
  return {
    pollId: state.pollId,
    ...(typeof state.openedAt === "string" ? { openedAt: state.openedAt } : {}),
    ...(typeof state.closesAt === "string" && Number.isFinite(Date.parse(state.closesAt)) ? { closesAt: state.closesAt } : {}),
    ...(state.requestedDurationSeconds === null || typeof state.requestedDurationSeconds === "number" &&
      Number.isSafeInteger(state.requestedDurationSeconds) && state.requestedDurationSeconds > 0
      ? { requestedDurationSeconds: state.requestedDurationSeconds } : {}),
    ...(state.title === null || typeof state.title === "string" && Array.from(state.title).length <= 80 ? { title: state.title } : {}),
    ...(state.status === "open" || state.status === "closing" || state.status === "closed" ? { status: state.status } : {}),
    ...(labels === undefined ? {} : { labels }),
    ...(kind === undefined ? {} : { kind }),
    ...(preset === undefined ? {} : { preset }),
    ...(typeof state.optionCount === "number" && Number.isInteger(state.optionCount) ? { optionCount: state.optionCount } : {}),
    ...(state.textMode === "first_word" || state.textMode === "whole_message" || state.textMode === null
      ? { textMode: state.textMode } : {}),
    counts: state.counts,
    ...(terms === undefined ? {} : { terms }),
    ...(isNonNegativeInteger(state.more) ? { more: state.more } : {}),
    ...(typeof state.termFilterReady === "boolean" ? { termFilterReady: state.termFilterReady } : {}),
    revision: state.revision as number,
    ...(Number.isSafeInteger(state.deadlineRevision) && (state.deadlineRevision as number) >= 0
      ? { deadlineRevision: state.deadlineRevision as number } : {}),
    ...(typeof state.closedAt === "string" ? { closedAt: state.closedAt } : {}),
  };
};

const isTallyState = (value: unknown): value is TallyState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.pollId === "string" && Array.isArray(state.counts) &&
    state.counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    typeof state.revision === "number" && Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    (state.status === undefined || state.status === "open" || state.status === "closing" || state.status === "closed") &&
    (state.deadlineRevision === undefined || Number.isSafeInteger(state.deadlineRevision) && (state.deadlineRevision as number) >= 0) &&
    (state.openedAt === undefined || typeof state.openedAt === "string" && Number.isFinite(Date.parse(state.openedAt))) &&
    (state.closesAt === undefined || typeof state.closesAt === "string" && Number.isFinite(Date.parse(state.closesAt))) &&
    (state.requestedDurationSeconds === undefined || state.requestedDurationSeconds === null ||
      typeof state.requestedDurationSeconds === "number" && Number.isSafeInteger(state.requestedDurationSeconds) && state.requestedDurationSeconds > 0) &&
    (state.title === undefined || state.title === null || typeof state.title === "string" && Array.from(state.title).length <= 80) &&
    (state.labels === undefined || Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")) &&
    (state.kind === undefined || state.kind === "yes_no" || state.kind === "options" || state.kind === "free_text") &&
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
  const previousDeadlineRevision = previous.deadlineRevision ?? 0;
  const incomingDeadlineRevision = incoming.deadlineRevision ?? 0;
  if (incoming.status === "closed") {
    const closed = { ...previous, ...incoming };
    if (incomingDeadlineRevision < previousDeadlineRevision) {
      if (previous.closesAt === undefined) delete closed.closesAt;
      else closed.closesAt = previous.closesAt;
      if (previous.requestedDurationSeconds === undefined) delete closed.requestedDurationSeconds;
      else closed.requestedDurationSeconds = previous.requestedDurationSeconds;
      closed.deadlineRevision = previousDeadlineRevision;
    } else {
      if (incoming.closesAt === undefined) {
        if (previous.closesAt === undefined) delete closed.closesAt;
        else closed.closesAt = previous.closesAt;
      }
      closed.deadlineRevision = incomingDeadlineRevision;
    }
    return closed;
  }
  if (previous.status === "closed") return previous;
  if (incoming.revision < previous.revision && incomingDeadlineRevision <= previousDeadlineRevision) return previous;
  // Deadline lifecycle invariant: every deadline change increments a persisted deadlineRevision; bootstrap and every tally carry it; this reducer takes closesAt only from the highest deadlineRevision, independent of ballot revision; the countdown latch resets when closesAt moves later for the same poll; a failed reschedule after a persisted extension is retried or the extension is rolled back so an alarm always exists for the persisted deadline.
  const merged = incoming.revision < previous.revision ? { ...previous } : { ...previous, ...incoming };
  if (incomingDeadlineRevision < previousDeadlineRevision) {
    if (previous.closesAt === undefined) delete merged.closesAt;
    else merged.closesAt = previous.closesAt;
    merged.deadlineRevision = previousDeadlineRevision;
    if (previous.requestedDurationSeconds !== undefined) merged.requestedDurationSeconds = previous.requestedDurationSeconds;
  } else {
    if (incoming.closesAt === undefined) {
      if (previous.closesAt === undefined) delete merged.closesAt;
      else merged.closesAt = previous.closesAt;
    } else {
      merged.closesAt = incoming.closesAt;
    }
    if (incoming.requestedDurationSeconds === undefined && previous.requestedDurationSeconds !== undefined) {
      merged.requestedDurationSeconds = previous.requestedDurationSeconds;
    }
    merged.deadlineRevision = incomingDeadlineRevision;
  }
  if (previous.status === "closing" && incoming.status === "open") merged.status = "closing";
  return merged;
};

/** Applies the tally reducer to arbitrary JSON realtime state. */
export const mergeTallyRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (!isTallyState(incoming) || current !== null && !isTallyState(current)) return incoming;
  return (mergeTallyState(current, incoming) ?? incoming) as unknown as Readonly<Record<string, unknown>>;
};
