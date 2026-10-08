export type VotekickOverlayStatus = "running" | "passed" | "expired" | "cancelled" | "failed";

export interface VotekickOverlayState {
  votekickId: string;
  targetLogin: string | null;
  targetUserId: string | null;
  yesVotes: number;
  noVotes: number;
  threshold: number;
  ballotRevision: number;
  status: VotekickOverlayStatus;
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isVotekickOverlayState = (value: unknown): value is VotekickOverlayState => {
  if (!isRecord(value)) return false;
  return typeof value.votekickId === "string" &&
    (value.targetLogin === null || typeof value.targetLogin === "string") &&
    (value.targetUserId === null || typeof value.targetUserId === "string") &&
    Number.isSafeInteger(value.yesVotes) && (value.yesVotes as number) >= 0 &&
    Number.isSafeInteger(value.noVotes) && (value.noVotes as number) >= 0 &&
    Number.isSafeInteger(value.threshold) && (value.threshold as number) > 0 &&
    Number.isSafeInteger(value.ballotRevision) && (value.ballotRevision as number) >= 0 &&
    (value.status === "running" || value.status === "passed" || value.status === "expired" ||
      value.status === "cancelled" || value.status === "failed") &&
    typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.endsAt === "string" && Number.isFinite(Date.parse(value.endsAt)) &&
    (value.endedAt === null || typeof value.endedAt === "string" && Number.isFinite(Date.parse(value.endedAt)));
};

const isNewerVotekick = (incoming: VotekickOverlayState, previous: VotekickOverlayState): boolean =>
  Date.parse(incoming.startedAt) > Date.parse(previous.startedAt);

export const mergeVotekickOverlayState = (
  previous: VotekickOverlayState | null,
  incoming: VotekickOverlayState,
): VotekickOverlayState => {
  if (previous === null) return incoming;
  if (incoming.votekickId !== previous.votekickId) return isNewerVotekick(incoming, previous) ? incoming : previous;
  if (previous.status !== "running") return previous;
  if (incoming.status !== "running") return incoming;
  if (incoming.ballotRevision < previous.ballotRevision) return previous;
  return { ...previous, ...incoming };
};

export const mergeVotekickRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  if (!isVotekickOverlayState(incoming)) return current ?? incoming;
  if (current !== null && !isVotekickOverlayState(current)) return incoming;
  return mergeVotekickOverlayState(current, incoming) as unknown as Readonly<Record<string, unknown>>;
};
