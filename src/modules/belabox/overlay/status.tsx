import { useEffect, useState, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { belaboxOverlayLabels } from "./locale";

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const Status = ({ config, state, now, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const [expiredBoundaryKey, setExpiredBoundaryKey] = useState<string | null>(null);
  const labels = belaboxOverlayLabels(language);
  const sample = record(state?.sample);
  const intervalSeconds = finiteNonnegative(state?.intervalSeconds) ? state.intervalSeconds : 15;
  const sampledAt = typeof sample?.at === "string" ? Date.parse(sample.at) : Number.NaN;
  const layout = config.layout === "detail" ? "detail" : "compact";
  const boundaryKey = Number.isFinite(sampledAt) ? `${String(sample?.at)}\u0000${String(intervalSeconds)}` : null;
  useEffect(() => {
    if (boundaryKey === null || !Number.isFinite(sampledAt)) return undefined;
    const staleAt = sampledAt + intervalSeconds * 3_000 + 1;
    if (staleAt <= now) return undefined;
    const timeout = window.setTimeout(() => setExpiredBoundaryKey(boundaryKey), staleAt - now);
    return () => window.clearTimeout(timeout);
  }, [boundaryKey, intervalSeconds, now, sampledAt]);
  const age = Math.max(0, now - sampledAt);
  const fresh = Number.isFinite(age) && age <= intervalSeconds * 3_000 && expiredBoundaryKey !== boundaryKey;
  const phase = sample?.phase === "low" || sample?.phase === "disconnected" || sample?.phase === "inactive"
    ? sample.phase
    : "healthy";
  if (config.hideWhenHealthy === true && (phase === "healthy" || phase === "inactive") && fresh) return null;

  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 1 });
  const bitrate = finiteNonnegative(sample?.bitrateKbps) ? sample.bitrateKbps : 0;
  const bitrateText = config.unit === "mbps"
    ? `${number.format(bitrate / 1_000)} ${labels.mbps}`
    : `${number.format(bitrate)} ${labels.kbps}`;
  const rttText = finiteNonnegative(sample?.rttMs) ? `${number.format(sample.rttMs)} ms` : labels.noData;
  const phaseText = labels[phase];

  return <span
    className={`brobot-module-text belabox-status belabox-status--${phase}`}
    aria-label={fresh ? phaseText : labels.noData}
    style={{
      boxSizing: "border-box",
      display: "grid",
      width: "320px",
      height: layout === "detail" ? "64px" : "40px",
      overflow: "hidden",
      alignContent: "center",
      gap: "2px",
      fontSize: "16px",
      lineHeight: 1.1,
      whiteSpace: "nowrap",
    }}
  >
    <strong>{fresh ? `${phaseText} · ${bitrateText}` : labels.noData}</strong>
    <span style={{ minHeight: "1.2em", visibility: layout === "detail" ? "visible" : "hidden" }}>
      {fresh ? `RTT ${rttText}` : "\u00a0"}
    </span>
  </span>;
};

export default Status;
