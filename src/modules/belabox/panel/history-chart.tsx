import type { CSSProperties, ReactElement } from "react";

import type { BelaboxHistoryPoint, BelaboxStreamSummary } from "../contracts";
import { BELABOX_STREAM_HISTORY_LIMIT } from "../contracts";
import { BELABOX_LOW_BITRATE_KBPS, BELABOX_RECOVER_BITRATE_KBPS } from "../domain/history";
import type { BelaboxPanelTexts } from "./locale";

const WIDTH = 640;
const HEIGHT = 200;
const PLOT = { left: 48, right: 12, top: 12, bottom: 28 };

interface HistoryChartProps {
  points: readonly BelaboxHistoryPoint[];
  range: "live" | "stream";
  locale: string;
  labels: BelaboxPanelTexts;
}

const HistoryChart = ({ points, range, locale, labels }: HistoryChartProps): ReactElement => {
  const firstAt = points[0]?.[0] ?? 0;
  const lastAt = points.at(-1)?.[0] ?? 0;
  const xStart = range === "live" ? lastAt - 10 * 60_000 : firstAt;
  const xEnd = range === "live" ? lastAt : Math.max(lastAt, xStart + 60_000);
  const maxBitrate = Math.max(BELABOX_RECOVER_BITRATE_KBPS, ...points.map((point) => point[1]));
  const yMaximum = Math.max(2_200, maxBitrate * 1.1);
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const x = (timestamp: number): number => PLOT.left + ((timestamp - xStart) / (xEnd - xStart)) * plotWidth;
  const y = (bitrate: number): number => PLOT.top + (1 - bitrate / yMaximum) * plotHeight;

  const connectedSegments: string[] = [];
  let segment: string[] = [];
  points.forEach((point) => {
    if (point[2] <= 0) {
      if (segment.length > 0) connectedSegments.push(segment.join(" "));
      segment = [];
      return;
    }
    segment.push(`${segment.length === 0 ? "M" : "L"}${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`);
  });
  if (segment.length > 0) connectedSegments.push(segment.join(" "));

  const dateFormatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const lowY = y(BELABOX_LOW_BITRATE_KBPS);
  const recoverY = y(BELABOX_RECOVER_BITRATE_KBPS);
  const markerWidth = Math.max(4, Math.min(14, plotWidth / Math.max(points.length, 1)));

  return <div style={{ position: "relative", height: HEIGHT, minHeight: HEIGHT }}>
    <svg viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} role="img" aria-label={labels.history}
      style={{ display: "block", width: "100%", height: HEIGHT }}>
      <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={PLOT.top + plotHeight} y2={PLOT.top + plotHeight}
        stroke="var(--line)" />
      {[0, 0.5, 1].map((fraction) => {
        const value = yMaximum * fraction;
        const yValue = y(value);
        return <g key={fraction}>
          <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={yValue} y2={yValue} stroke="var(--line)" strokeOpacity="0.55" />
          <text x={PLOT.left - 8} y={yValue + 4} textAnchor="end" fill="var(--text-3)"
            fontFamily="IBM Plex Mono, ui-monospace, monospace" fontSize="10">{Math.round(value)}</text>
        </g>;
      })}
      <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={lowY} y2={lowY}
        stroke="var(--warn)" strokeDasharray="5 4" />
      <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={recoverY} y2={recoverY}
        stroke="var(--green)" strokeDasharray="5 4" />
      {points.filter((point) => point[2] < 1).map((point) => <rect key={`${String(point[0])}-${String(point[2])}`}
        x={x(point[0]) - markerWidth / 2} y={PLOT.top} width={markerWidth} height={plotHeight}
        fill="var(--error-surface)" />)}
      {connectedSegments.map((path, index) => <path key={index} d={path} fill="none" stroke="var(--text-2)"
        strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
      {points.filter((point) => point[2] > 0).map((point) => <circle key={point[0]} cx={x(point[0])} cy={y(point[1])}
        r="2.5" fill="var(--green)" />)}
      {points.length > 0 ? <>
        <text x={PLOT.left} y={HEIGHT - 6} fill="var(--text-3)" fontSize="10">{dateFormatter.format(xStart)}</text>
        <text x={WIDTH - PLOT.right} y={HEIGHT - 6} textAnchor="end" fill="var(--text-3)" fontSize="10">
          {dateFormatter.format(xEnd)}
        </text>
      </> : null}
    </svg>
    {points.length === 0 ? <p className="muted" role="status" aria-live="polite"
      style={{ position: "absolute", inset: "0 0 0 0", display: "grid", placeItems: "center", margin: 0 }}>
      {labels.noHistory}
    </p> : null}
  </div>;
};

interface BelaboxHistorySectionProps {
  labels: BelaboxPanelTexts;
  locale: string;
  points: readonly BelaboxHistoryPoint[];
  streams: readonly BelaboxStreamSummary[];
  selectedStreamId: string | null;
  range: "live" | "stream";
  onRangeChange: (range: "live" | "stream") => void;
  onStreamSelect: (streamId: string) => void;
  onDemand: boolean;
}

const timestampLabel = (value: string, locale: string): string => {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf())
    ? ""
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
};

export const BelaboxHistorySection = ({
  labels,
  locale,
  points,
  streams,
  selectedStreamId,
  range,
  onRangeChange,
  onStreamSelect,
  onDemand,
}: BelaboxHistorySectionProps): ReactElement => {
  const toggleStyle = (active: boolean): CSSProperties => ({
    minHeight: 44,
    padding: "0 var(--s4)",
    border: `1px solid ${active ? "var(--brand-line)" : "var(--line-strong)"}`,
    borderRadius: "var(--r-control)",
    color: active ? "var(--brand-text)" : "var(--text-2)",
    background: active ? "var(--tint-2)" : "var(--surface-raised)",
    cursor: "pointer",
  });

  return <section className="config-section" aria-label={labels.history}>
    <div className="section-heading"><h3>{labels.history}</h3></div>
    {onDemand ? <p className="muted" role="status" style={{ minHeight: HEIGHT, display: "grid", placeItems: "center", margin: 0, textAlign: "center" }}>
      {labels.onDemandHistory}
    </p> : <>
      <div role="group" aria-label={labels.history} style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s3)" }}>
        <button type="button" aria-pressed={range === "live"} style={toggleStyle(range === "live")}
          onClick={() => onRangeChange("live")}>{labels.liveRange}</button>
        <button type="button" aria-pressed={range === "stream"} style={toggleStyle(range === "stream")}
          onClick={() => onRangeChange("stream")}>{labels.streamRange}</button>
      </div>
      <HistoryChart points={points} range={range} locale={locale} labels={labels} />
      <div aria-label={labels.history} style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2) var(--s4)", color: "var(--text-2)", fontSize: 12 }}>
        <span><i aria-hidden="true" style={{ display: "inline-block", width: 16, borderTop: "2px solid var(--text-2)", marginRight: 6, verticalAlign: "middle" }} />{labels.bitrate}</span>
        <span><i aria-hidden="true" style={{ display: "inline-block", width: 16, borderTop: "2px dashed var(--warn)", marginRight: 6, verticalAlign: "middle" }} />{labels.lowThreshold}: {BELABOX_LOW_BITRATE_KBPS.toLocaleString(locale)} kbps</span>
        <span><i aria-hidden="true" style={{ display: "inline-block", width: 16, borderTop: "2px dashed var(--green)", marginRight: 6, verticalAlign: "middle" }} />{labels.recoverThreshold}: {BELABOX_RECOVER_BITRATE_KBPS.toLocaleString(locale)} kbps</span>
        <span><i aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, background: "var(--error-surface)", border: "1px solid var(--error)", marginRight: 6, verticalAlign: "middle" }} />{labels.disconnects}</span>
      </div>
      <h4 style={{ margin: "var(--s5) 0 var(--s2)", fontSize: 13 }}>{labels.streams}</h4>
      {streams.length === 0 ? <p className="muted" role="status" style={{ minHeight: 44, margin: 0, display: "flex", alignItems: "center" }}>{labels.noStreams}</p> :
        <div aria-label={labels.streams} data-testid="belabox-stream-history-list"
          style={{ maxHeight: 320, overflowY: "auto", scrollbarGutter: "stable" }}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {streams.slice(0, BELABOX_STREAM_HISTORY_LIMIT).map((stream) => {
            const active = stream.streamId === selectedStreamId;
            return <li key={stream.streamId} style={{ borderBottom: "1px solid var(--line)" }}>
              <button type="button" aria-pressed={active} onClick={() => {
                onStreamSelect(stream.streamId);
                onRangeChange("stream");
              }} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "var(--s2) var(--s4)", width: "100%", minHeight: 44,
                padding: "var(--s2) 0", border: 0, borderLeft: active ? "2px solid var(--brand)" : "2px solid transparent",
                background: active ? "var(--tint-1)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}>
                <span title={timestampLabel(stream.startedAt, locale)} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {labels.streamStarted}: {timestampLabel(stream.startedAt, locale)}
                </span>
                <span className="mono" style={{ color: "var(--text-2)", minWidth: 0, textAlign: "right", overflowWrap: "anywhere" }}>
                  {labels.averageBitrate} {Math.round(stream.bitrateAvg)} · {labels.p10Bitrate} {stream.bitrateP10 === null ? "—" : Math.round(stream.bitrateP10)} kbps
                </span>
                <span className="muted" style={{ gridColumn: "1 / -1", overflowWrap: "anywhere" }}>
                  {labels.disconnects}: {stream.disconnectCount} · {labels.droppedPackets}: {Math.round(stream.droppedTotal)}
                </span>
              </button>
            </li>;
          })}
          </ul>
        </div>}
    </>}
  </section>;
};
