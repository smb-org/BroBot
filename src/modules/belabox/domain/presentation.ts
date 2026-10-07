import {
  BELABOX_DEFAULT_LOW_BITRATE_KBPS,
  type BelaboxPhase,
  type BelaboxSample,
} from "../contracts";

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
): BelaboxSample => {
  const phase = belaboxPhase(sample, classified, lowBitrateKbps);
  const previousTotal = sameStream ? previous?.droppedTotal ?? 0 : 0;
  const previousCounter = sameStream ? previous?.droppedPackets : undefined;
  const droppedDelta = previousCounter === undefined || sample.droppedPackets < previousCounter
    ? 0
    : sample.droppedPackets - previousCounter;
  const previousPhase = previous?.phase ?? (previous === null ? "healthy" : belaboxPhase(previous, true, lowBitrateKbps));
  const alertStartedAt = unhealthy(phase)
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
): BelaboxPhase => sample.phase ?? belaboxPhase(sample, classified, lowBitrateKbps);

export const belaboxDownMilliseconds = (sample: BelaboxSample, now: number): number => {
  const phase = resolvedBelaboxPhase(sample);
  if (!unhealthy(phase) || sample.alertStartedAt == null) return 0;
  const startedAt = Date.parse(sample.alertStartedAt);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
};
