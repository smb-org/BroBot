import type { BelaboxPhase, BelaboxStatusResponse } from "../modules/belabox/contracts";

export interface LiveCockpitBelaboxObservation {
  observedAt: number;
  sampledAt: number | null;
  connected: boolean;
  bitrateKbps: number;
  phase: BelaboxPhase | null;
  failed: boolean;
  configured: boolean | null;
  intervalSeconds: number;
}

export const belaboxObservationFromStatus = (
  data: BelaboxStatusResponse,
  observedAt: number,
): LiveCockpitBelaboxObservation => {
  const sampleAt = data.sample === null ? Number.NaN : Date.parse(data.sample.at);
  const failed = data.fetchFailureNotice || data.errorCode !== null;
  return {
    observedAt,
    sampledAt: !failed && Number.isFinite(sampleAt) ? sampleAt : null,
    connected: !failed && data.sample?.connected === true,
    bitrateKbps: !failed ? data.sample?.bitrateKbps ?? 0 : 0,
    phase: !failed ? data.sample?.phase ?? null : null,
    failed,
    configured: data.configured,
    intervalSeconds: data.intervalSeconds,
  };
};

export const failedBelaboxObservation = (
  observedAt: number,
  previous: LiveCockpitBelaboxObservation | null,
): LiveCockpitBelaboxObservation => ({
  observedAt,
  sampledAt: null,
  connected: false,
  bitrateKbps: 0,
  phase: null,
  failed: true,
  configured: previous?.configured ?? null,
  intervalSeconds: previous?.intervalSeconds ?? 5,
});

export const successfulManualBelaboxObservation = (
  observedAt: number,
  sampledAt: number,
  connected: boolean,
  bitrateKbps: number,
  previous: LiveCockpitBelaboxObservation | null,
): LiveCockpitBelaboxObservation => ({
  observedAt,
  sampledAt,
  connected,
  bitrateKbps,
  phase: null,
  failed: false,
  configured: true,
  intervalSeconds: previous?.intervalSeconds ?? 5,
});

export const latestBelaboxObservation = (
  current: LiveCockpitBelaboxObservation | null,
  incoming: LiveCockpitBelaboxObservation,
): LiveCockpitBelaboxObservation => current === null || incoming.observedAt >= current.observedAt ? incoming : current;

export const belaboxObservationIsExpired = (
  observation: LiveCockpitBelaboxObservation,
  now: number,
): boolean => {
  if (observation.sampledAt === null || !Number.isFinite(observation.sampledAt)) return true;
  const age = now - observation.sampledAt;
  const expiryMs = Math.max(1, observation.intervalSeconds) * 2_000;
  return age < 0 || age > expiryMs;
};
