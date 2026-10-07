import type { BelaboxSample } from "../contracts";

export const BELABOX_LOW_BITRATE_KBPS = 1_000;
export const BELABOX_RECOVER_BITRATE_KBPS = 2_000;

export const minuteAtForSample = (at: string): string | null => {
  const timestamp = Date.parse(at);
  return Number.isFinite(timestamp) ? `${new Date(timestamp).toISOString().slice(0, 16)}:00.000Z` : null;
};

export const droppedPacketDelta = (sample: BelaboxSample, previous: BelaboxSample | null): number => {
  if (previous === null) return sample.droppedPackets;
  return sample.droppedPackets >= previous.droppedPackets
    ? sample.droppedPackets - previous.droppedPackets
    : sample.droppedPackets;
};

export const elapsedSampleSeconds = (previous: BelaboxSample | null, current: BelaboxSample): number => {
  if (previous === null) return 0;
  const elapsed = (Date.parse(current.at) - Date.parse(previous.at)) / 1_000;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
};

/** Uses the nearest-rank tenth percentile, keeping the summary stable for short streams. */
export const bitrateP10 = (values: readonly number[]): number | null => {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return finite[Math.max(0, Math.ceil(finite.length * 0.1) - 1)] ?? null;
};
