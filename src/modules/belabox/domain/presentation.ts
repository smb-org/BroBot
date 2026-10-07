import {
  BELABOX_DEFAULT_LOW_BITRATE_KBPS,
  type BelaboxPhase,
  type BelaboxSample,
} from "../contracts";
import type { BelaboxAlertState } from "./alert";
import { droppedPacketDelta } from "./history";

const unhealthy = (phase: BelaboxPhase): boolean => phase === "low" || phase === "disconnected";

export const belaboxPhase = (
  sample: Pick<BelaboxSample, "connected" | "bitrateKbps">,
  classified = true,
  lowBitrateKbps = BELABOX_DEFAULT_LOW_BITRATE_KBPS,
): BelaboxPhase => !classified
  ? "inactive"
  : !sample.connected
    ? "disconnected"
    : sample.bitrateKbps < lowBitrateKbps ? "low" : "healthy";

export const enrichBelaboxSample = (
  sample: BelaboxSample,
  previous: BelaboxSample | null,
  sameStream: boolean,
  classified: boolean,
  lowBitrateKbps = BELABOX_DEFAULT_LOW_BITRATE_KBPS,
  alertState?: BelaboxAlertState,
): BelaboxSample => {
  const phase = resolvedBelaboxPhase(sample, classified, lowBitrateKbps, alertState);
  const previousTotal = sameStream ? previous?.droppedTotal ?? 0 : 0;
  const droppedDelta = sameStream && previous?.connected === true && sample.connected
    ? droppedPacketDelta(sample, previous)
    : 0;
  const previousPhase = previous === null || previous.phase === "inactive"
    ? "healthy"
    : belaboxPhase(previous, true, lowBitrateKbps);
  const alertStartedAt = alertState !== undefined && alertState.phase !== "ok"
    ? belaboxPresentationAlertStartedAt(sample, phase, alertState)
    : unhealthy(phase)
      ? sameStream && unhealthy(previousPhase) ? previous?.alertStartedAt ?? previous?.at ?? sample.at : sample.at
      : null;
  return {
    ...sample,
    droppedTotal: previousTotal + droppedDelta,
    phase,
    alertStartedAt,
  };
};

export const resolvedBelaboxPhase = (
  sample: BelaboxSample,
  classified = true,
  lowBitrateKbps = BELABOX_DEFAULT_LOW_BITRATE_KBPS,
  alertState?: BelaboxAlertState,
): BelaboxPhase => alertState !== undefined && alertState.phase !== "ok" && alertState.kind !== null
  ? alertState.kind === "low" ? "low" : "disconnected"
  : belaboxPhase(sample, classified, lowBitrateKbps);

export const belaboxPresentationAlertStartedAt = (
  sample: BelaboxSample,
  phase: BelaboxPhase,
  alertState?: BelaboxAlertState,
): string | null => {
  if (!unhealthy(phase)) return null;
  if (alertState !== undefined && alertState.phase !== "ok" && alertState.kind !== null) {
    const stateStart = alertState.phase === "pending" ? alertState.since : alertState.episodeStartedAt;
    if (stateStart !== null) return stateStart;
  }
  return sample.alertStartedAt ?? sample.at;
};

export const belaboxDownMilliseconds = (
  sample: BelaboxSample,
  now: number,
  lowBitrateKbps = BELABOX_DEFAULT_LOW_BITRATE_KBPS,
  classified = true,
  alertState?: BelaboxAlertState,
): number => {
  const phase = resolvedBelaboxPhase(sample, classified, lowBitrateKbps, alertState);
  if (!unhealthy(phase)) return 0;
  const alertStartedAt = belaboxPresentationAlertStartedAt(sample, phase, alertState);
  if (alertStartedAt === null) return 0;
  const startedAt = Date.parse(alertStartedAt);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
};
