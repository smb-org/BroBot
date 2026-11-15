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
  .filter((request) => request.state === "submitted" && request.trackId === trackId && request.streamId === streamId)
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0] ?? null;

export type SongRequestState = "pending_review" | "approved" | "submitting" | "submitted" | "observed_playing" |
  "not_observed" | "outcome_unknown" | "rejected" | "removed" | "failed";

export const streamOfflineTransitions = (states: readonly SongRequestState[]): (SongRequestState | null)[] =>
  states.map((state) => state === "submitted" ? "not_observed"
    : state === "pending_review" || state === "approved" ? "rejected"
      : state === "outcome_unknown" ? "failed" : null);
