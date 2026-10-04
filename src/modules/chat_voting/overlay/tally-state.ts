export interface TallyState {
  pollId: string;
  status?: "open" | "closed";
  labels?: readonly string[];
  counts: readonly number[];
  revision: number;
  closedAt?: string;
}

const isTallyState = (value: unknown): value is TallyState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.pollId === "string" && Array.isArray(state.counts) &&
    state.counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    typeof state.revision === "number" && Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    (state.status === undefined || state.status === "open" || state.status === "closed") &&
    (state.labels === undefined || Array.isArray(state.labels) && state.labels.every((label) => typeof label === "string")) &&
    (state.closedAt === undefined || typeof state.closedAt === "string");
};

/** Keeps delayed partial tally messages from replacing newer ballot state. */
export const mergeTallyState = (previous: TallyState | null, incoming: TallyState | null): TallyState | null => {
  if (incoming === null) return previous;
  if (previous === null) return incoming;
  if (incoming.pollId !== previous.pollId) {
    return incoming.status === "open" || incoming.status === "closed" ? incoming : previous;
  }
  if (incoming.status === "closed") {
    if (incoming.revision < previous.revision) {
      return {
        ...previous,
        status: "closed",
        ...(incoming.closedAt === undefined ? {} : { closedAt: incoming.closedAt }),
      };
    }
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
