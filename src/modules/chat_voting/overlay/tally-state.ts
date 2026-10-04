export interface TallyState {
  pollId: string;
  status?: "open" | "closed";
  labels?: readonly string[];
  counts: readonly number[];
  revision: number;
  closedAt?: string;
}

/** Keeps delayed partial tally messages from replacing newer ballot state. */
export const mergeTallyState = (previous: TallyState | null, incoming: TallyState | null): TallyState | null => {
  if (incoming === null) return null;
  if (previous === null) return incoming;
  if (incoming.pollId !== previous.pollId) {
    return incoming.status === "open" || incoming.status === "closed" ? incoming : previous;
  }
  if (incoming.status === "closed") return { ...previous, ...incoming };
  if (incoming.revision < previous.revision) return previous;
  return { ...previous, ...incoming };
};
