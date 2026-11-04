import type { PollsKind, PollsRun } from "../contracts";
import type { PollsPanelState } from "./service";
import { pollsPanelTexts } from "./locale";

const isOpenRun = (run: PollsRun): boolean => run.status === "active" || run.status === "locked";

const isPollsRun = (value: unknown): value is PollsRun => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === "string" && (run.kind === "poll" || run.kind === "prediction") &&
    typeof run.startedAt === "string" && typeof run.status === "string" &&
    (typeof run.dismissedAt === "string" || run.dismissedAt === null);
};

export const isPollsPanelState = (value: unknown): value is PollsPanelState => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (typeof state.active !== "object" || state.active === null || Array.isArray(state.active) ||
      !Array.isArray(state.open) || !Array.isArray(state.entries)) return false;
  const active = state.active as Record<string, unknown>;
  return (active.poll === null || isPollsRun(active.poll)) &&
    (active.prediction === null || isPollsRun(active.prediction)) &&
    state.open.every(isPollsRun);
};

export const blockingPollsRun = (state: PollsPanelState, kind: PollsKind): PollsRun | null => {
  const active = state.active[kind];
  if (active !== null && isOpenRun(active)) return active;
  if (kind === "prediction") {
    return state.open.find((run) => run.kind === kind && run.status === "locked") ?? null;
  }
  return null;
};

export const pollsEntryStartReason = (
  state: PollsPanelState,
  kind: PollsKind,
  language: "de" | "en",
): string | null => {
  const blocked = blockingPollsRun(state, kind);
  if (blocked === null) return null;
  const labels = pollsPanelTexts[language];
  return blocked.status === "locked"
    ? labels.runningLockReason
    : kind === "poll" ? labels.runningPollReason : labels.runningPredictionReason;
};

export const openPollsPredictions = (state: PollsPanelState): PollsRun[] => {
  const runs = [state.active.prediction, ...state.open].filter((run): run is PollsRun => run !== null && run.kind === "prediction" && (
    run.status === "active" || run.status === "locked" || (run.status === "unknown" && run.dismissedAt === null)
  ));
  const unique = [...new Map(runs.map((run) => [run.id, run])).values()];
  return unique.sort((left, right) => {
    const leftStartedAt = Date.parse(left.startedAt);
    const rightStartedAt = Date.parse(right.startedAt);
    if (!Number.isFinite(leftStartedAt)) return Number.isFinite(rightStartedAt) ? 1 : 0;
    if (!Number.isFinite(rightStartedAt)) return -1;
    return leftStartedAt - rightStartedAt;
  });
};
