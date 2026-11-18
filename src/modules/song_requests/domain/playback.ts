export type SubmittedRequest = {
  id: string;
  trackId: string;
  streamId: string | null;
  state: "submitted";
  createdAt: string;
};

export const matchSubmittedRequest = <Request extends SubmittedRequest>(
  requests: readonly Request[],
  trackId: string,
  streamId: string,
): Request | null => requests
  .filter((request) => request.trackId === trackId && request.streamId === streamId)
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0] ?? null;

export type SongRequestState = "pending_review" | "approved" | "submitting" | "submitted" | "observed_playing" |
  "not_observed" | "outcome_unknown" | "rejected" | "removed" | "failed";

export const streamOfflineTransitions = (states: readonly SongRequestState[]): (SongRequestState | null)[] =>
  states.map((state) => state === "submitted" ? "not_observed"
    : state === "pending_review" || state === "approved" ? "rejected"
      : state === "outcome_unknown" ? "failed" : null);

export const interpolatePlaybackProgress = (progressMs: number, durationMs: number, observedAt: number, now: number): number => {
  const elapsed = Math.max(0, now - observedAt);
  return Math.max(0, Math.min(durationMs, Math.floor(progressMs + elapsed)));
};

export const formatPlaybackTime = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
};
