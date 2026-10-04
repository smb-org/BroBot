export interface TallyState {
  pollId: string;
  openedAt?: string;
  status?: "open" | "closed";
  labels?: readonly string[];
  counts: readonly number[];
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
    (state.labels === undefined || Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")) &&
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
