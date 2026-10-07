const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

export const mergeBelaboxRealtimeState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const sample = record(incoming);
  if (sample === null || typeof sample.at !== "string" || typeof sample.connected !== "boolean" ||
      typeof sample.bitrateKbps !== "number" || typeof sample.rttMs !== "number" ||
      !["healthy", "low", "disconnected", "inactive"].includes(String(sample.phase)) ||
      !(sample.streamSessionKey === null || typeof sample.streamSessionKey === "string")) return current ?? {};
  if (current === null || !(current.streamSessionKey === null || typeof current.streamSessionKey === "string") ||
      sample.streamSessionKey !== current.streamSessionKey) return current ?? {};
  const currentSample = record(current.sample);
  const incomingAt = Date.parse(sample.at);
  const currentAt = typeof currentSample?.at === "string" ? Date.parse(currentSample.at) : Number.NaN;
  if (Number.isFinite(incomingAt) && Number.isFinite(currentAt) && incomingAt < currentAt) return current;
  return { ...current, sample: { ...sample } };
};
