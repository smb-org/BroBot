import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { StatisticsStreamEvent, StatisticsStreamSummary, StatisticsStreamWindow, StatisticsBitrateWindow } from "../contracts";
import type { StatisticsPanelTexts } from "./locale";
import { STATISTICS_CHART_PLOT, statisticsChartAreaPath, statisticsChartAxisTicks, statisticsChartLinePath, statisticsChartScaleY } from "./chart-primitives";

type Metric = "viewer-chat" | "chatter" | "bitrate";
type MarkerType = Extract<StatisticsStreamEvent["type"], "metadata" | "clip" | "ad" | "drop" | "emoteSpike">;

interface ChartSeries {
  name: string;
  color: string;
  values: Array<number | null>;
  side: "left" | "right";
  unit: string;
}

interface ChartMarker {
  event: StatisticsStreamEvent & { type: MarkerType };
  x: number;
  lane: number;
  color: string;
  label: string;
}

interface StatisticsHistoryChartProps {
  summary: StatisticsStreamSummary;
  windows: readonly StatisticsStreamWindow[];
  bitrateWindows: readonly StatisticsBitrateWindow[];
  events: readonly StatisticsStreamEvent[];
  language: "de" | "en";
  labels: StatisticsPanelTexts;
  highlightedEventId: string | null;
  onHighlightEvent: (eventId: string | null) => void;
}

const CHART_HEIGHT = 218;
const LANE_STRIP_TOP = STATISTICS_CHART_PLOT.bottom + 20;
const MARKER_TYPES: readonly MarkerType[] = ["metadata", "clip", "ad", "drop", "emoteSpike"];
const labelForEvent = (event: Pick<StatisticsStreamEvent, "type">, labels: StatisticsPanelTexts): string => {
  if (event.type === "metadata") return labels.metadata;
  if (event.type === "clip") return labels.clip;
  if (event.type === "ad") return labels.ad;
  if (event.type === "drop") return labels.drop;
  if (event.type === "emoteSpike") return labels.emoteSpike;
  if (event.type === "offline") return labels.offline;
  return labels.start;
};

const eventDetail = (event: StatisticsStreamEvent, labels: StatisticsPanelTexts): string => {
  if (event.type === "metadata") {
    const title = event.oldTitle === event.title ? "" : `${event.oldTitle ?? "—"} → ${event.title ?? "—"}`;
    const category = event.oldCategory === event.category ? "" : `${event.oldCategory ?? "—"} → ${event.category ?? "—"}`;
    return [category, title].filter(Boolean).join(" · ");
  }
  if (event.type === "clip") return event.text ?? labels.clip;
  if (event.type === "ad") return `${String(event.durationSeconds ?? 0)} s`;
  if (event.type === "drop") return `${String(event.durationSeconds ?? 0)} s`;
  if (event.type === "emoteSpike") return labels.emotesInWindow(String(event.emotes ?? 0));
  return labelForEvent(event, labels);
};

const AXIS_DIVISIONS = 4;

/** Axis maximum on a round step so that every one of the four axis intervals has a clean value. */
const maximumOf = (values: readonly (number | null)[]): number => {
  const maximum = Math.max(0, ...values.filter((value): value is number => value !== null));
  if (maximum <= AXIS_DIVISIONS) return AXIS_DIVISIONS;
  const raw = maximum / AXIS_DIVISIONS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= raw / magnitude) ?? 10;
  return step * magnitude * AXIS_DIVISIONS;
};

const markerShape = (type: MarkerType, x: number, y: number): ReactElement => {
  if (type === "metadata") return <path d={`M ${String(x)} ${String(y - 6)} l 6 6 -6 6 -6 -6 z`} />;
  if (type === "clip") return <circle cx={x} cy={y} r="5.5" />;
  if (type === "ad") return <rect x={x - 5} y={y - 5} width="10" height="10" rx="1" />;
  if (type === "drop") return <path d={`M ${String(x)} ${String(y - 6)} l 6 11 h -12 z`} />;
  return <path d={`M ${String(x)} ${String(y - 7)} l 2 5 5 -2 -3 4 4 3 -5 1 -1 5 -3 -4 -4 3 1 -5 -4 -3 5 -1 z`} />;
};

const timeLabel = (value: string, language: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date);
};

const valueLabel = (value: number, language: string): string => new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);

const markerColor = (type: MarkerType): string => {
  if (type === "metadata") return "var(--color-chart-1)";
  if (type === "clip") return "var(--color-chart-3)";
  if (type === "ad") return "var(--color-chart-5)";
  if (type === "drop") return "var(--color-chart-2)";
  return "var(--color-chart-4)";
};

const markerCandidates = (events: readonly StatisticsStreamEvent[], labels: StatisticsPanelTexts, start: number, end: number, width: number): ChartMarker[] => {
  const plotWidth = Math.max(1, width - STATISTICS_CHART_PLOT.left - STATISTICS_CHART_PLOT.right);
  const candidates = events.flatMap((event) => {
    if (event.type !== "metadata" && event.type !== "clip" && event.type !== "ad" && event.type !== "drop" && event.type !== "emoteSpike") return [];
    const timestamp = Date.parse(event.at);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) return [];
    return [{ event: event as StatisticsStreamEvent & { type: MarkerType }, x: STATISTICS_CHART_PLOT.left + ((timestamp - start) / Math.max(1, end - start)) * plotWidth, color: markerColor(event.type), label: labelForEvent(event, labels), lane: 0 }];
  });
  const lastXByLane = [-Infinity, -Infinity];
  return candidates.map((marker) => {
    const firstLane = lastXByLane[0] ?? -Infinity;
    const secondLane = lastXByLane[1] ?? -Infinity;
    const lane = firstLane + 22 <= marker.x ? 0 : secondLane + 22 <= marker.x ? 1 : firstLane <= secondLane ? 0 : 1;
    lastXByLane[lane] = marker.x;
    return { ...marker, lane };
  });
};

export function StatisticsHistoryChart({ summary, windows, bitrateWindows, events, language, labels, highlightedEventId, onHighlightEvent }: StatisticsHistoryChartProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(STATISTICS_CHART_PLOT.width);
  const [metric, setMetric] = useState<Metric>("viewer-chat");
  const start = Date.parse(summary.startedAt);
  const end = Date.parse(summary.endedAt);
  const hasBitrate = bitrateWindows.length > 0;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? container.getBoundingClientRect().width;
      if (nextWidth > 0) setWidth(Math.max(260, Math.round(nextWidth)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const series = useMemo<ChartSeries[]>(() => {
    if (metric === "bitrate") {
      const bitrateByWindow = new Map(bitrateWindows.map((window) => [window.windowStart, window.bitrateAvg]));
      return [{ name: labels.bitrate, color: "var(--color-chart-4)", values: windows.map((window) => bitrateByWindow.get(Date.parse(window.windowStart)) ?? null), side: "left", unit: labels.bitrateUnit }];
    }
    if (metric === "chatter") {
      return [{ name: labels.chatter, color: "var(--color-chart-5)", values: windows.map(({ activeChatters }) => activeChatters), side: "left", unit: labels.chatterUnit }];
    }
    return [
      { name: labels.viewer, color: "var(--color-chart-1)", values: windows.map(({ viewerCount }) => viewerCount), side: "left", unit: labels.viewer },
      { name: labels.messages, color: "var(--color-chart-3)", values: windows.map(({ messages }) => messages), side: "right", unit: labels.messagesUnit },
    ];
  }, [bitrateWindows, labels.bitrate, labels.bitrateUnit, labels.chatter, labels.chatterUnit, labels.messages, labels.messagesUnit, labels.viewer, metric, windows]);

  const primarySeries = series[0];
  const leftMaximum = maximumOf(series.filter(({ side }) => side === "left").flatMap(({ values }) => values));
  const rightSeries = series.find(({ side }) => side === "right");
  const rightMaximum = rightSeries === undefined ? 0 : maximumOf(rightSeries.values);
  const plotWidth = Math.max(1, width - STATISTICS_CHART_PLOT.left - STATISTICS_CHART_PLOT.right);
  const markerData = useMemo(() => markerCandidates(events, labels, start, end, width), [end, events, labels, start, width]);
  const focusedMarker = markerData.find(({ event }) => event.id === highlightedEventId);
  const focusedTimestamp = focusedMarker === undefined ? null : Date.parse(focusedMarker.event.at);
  const focusedIndex = focusedTimestamp === null ? -1 : windows.reduce((bestIndex, window, index) => {
    const previous = windows[bestIndex];
    if (previous === undefined) return index;
    return Math.abs(Date.parse(window.windowStart) - focusedTimestamp) < Math.abs(Date.parse(previous.windowStart) - focusedTimestamp) ? index : bestIndex;
  }, 0);
  const focusedPrimaryValue = focusedIndex < 0 ? null : primarySeries?.values[focusedIndex] ?? null;
  const focusedX = focusedIndex < 0 ? null : STATISTICS_CHART_PLOT.left + ((Date.parse(windows[focusedIndex]?.windowStart ?? summary.startedAt) - start) / Math.max(1, end - start)) * plotWidth;
  const focusedY = focusedPrimaryValue === null ? null : statisticsChartScaleY(focusedPrimaryValue, leftMaximum);
  const averageLineValue = primarySeries === undefined
    ? null
    : primarySeries.values.filter((value): value is number => value !== null).reduce((sum, value, _index, values) => sum + value / values.length, 0);
  const averageY = averageLineValue === null ? null : statisticsChartScaleY(averageLineValue, leftMaximum);
  const markers = markerData;

  const metricButton = (value: Metric, label: string, disabled = false, reason?: string): ReactElement => <button
    type="button"
    aria-pressed={metric === value}
    disabled={disabled}
    title={reason}
    onClick={() => { if (!disabled) setMetric(value); }}
  >{label}</button>;

  return <div className="statistics-chart" ref={containerRef}>
    <div className="statistics-chart__header">
      <div className="statistics-chart__title">
        <h3>{labels.history}</h3>
        <span>{labels.fiveMinuteWindows}</span>
      </div>
      <div className="statistics-chart__controls" role="group" aria-label={labels.chartFocus}>
        {metricButton("viewer-chat", labels.viewerChat)}
        {metricButton("chatter", labels.chatter)}
        {metricButton("bitrate", labels.bitrate, !hasBitrate, !hasBitrate ? labels.noBitrate : undefined)}
      </div>
    </div>
    <div className="statistics-chart__canvas" role="region" aria-label={labels.history}>
      {focusedMarker === undefined ? null : <div id="statistics-stream-marker-tooltip" className="statistics-chart__tooltip" role="tooltip" style={{
        left: `${String((focusedMarker.x / width) * 100)}%`,
        transform: focusedMarker.x / width < 0.2 ? "translateX(0)" : focusedMarker.x / width > 0.8 ? "translateX(-100%)" : "translateX(-50%)",
      }}>
        <strong>{labelForEvent(focusedMarker.event, labels)}</strong>
        <span>{timeLabel(focusedMarker.event.at, language)} · {eventDetail(focusedMarker.event, labels)}</span>
      </div>}
      <svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${String(width)} ${String(CHART_HEIGHT)}`} role="group" aria-label={labels.history}>
        <text x={STATISTICS_CHART_PLOT.left} y="12" textAnchor="start" fill="var(--text-3)" fontSize="11">{primarySeries?.unit}</text>
        {rightSeries === undefined ? null : <text x={width - STATISTICS_CHART_PLOT.right} y="12" textAnchor="end" fill="var(--text-3)" fontSize="11">{rightSeries.unit}</text>}
        {events.filter((event) => event.type === "drop" && event.recoveredAt !== undefined).map((event) => {
          const x1 = STATISTICS_CHART_PLOT.left + ((Date.parse(event.at) - start) / Math.max(1, end - start)) * plotWidth;
          const x2 = STATISTICS_CHART_PLOT.left + ((Date.parse(event.recoveredAt ?? event.at) - start) / Math.max(1, end - start)) * plotWidth;
          return <rect key={`zone-${event.id}`} x={Math.max(STATISTICS_CHART_PLOT.left, x1)} y={STATISTICS_CHART_PLOT.top} width={Math.max(2, Math.min(STATISTICS_CHART_PLOT.left + plotWidth, x2) - Math.max(STATISTICS_CHART_PLOT.left, x1))} height={STATISTICS_CHART_PLOT.bottom - STATISTICS_CHART_PLOT.top} fill="var(--color-chart-2)" opacity="0.12" />;
        })}
        {statisticsChartAxisTicks(leftMaximum, AXIS_DIVISIONS).map(({ fraction, value }) => {
          const y = STATISTICS_CHART_PLOT.top + (STATISTICS_CHART_PLOT.bottom - STATISTICS_CHART_PLOT.top) * fraction;
          return <g key={fraction}>
            <line x1={STATISTICS_CHART_PLOT.left} x2={width - STATISTICS_CHART_PLOT.right} y1={y} y2={y} stroke="var(--line)" strokeDasharray={fraction === 1 ? undefined : "2 4"} />
            <text x={STATISTICS_CHART_PLOT.left - 8} y={y + 4} textAnchor="end" fill="var(--text-3)" fontSize="11">{valueLabel(value, language)}</text>
            {rightSeries === undefined ? null : <text x={width - STATISTICS_CHART_PLOT.right + 8} y={y + 4} textAnchor="start" fill="var(--text-3)" fontSize="11">{valueLabel(rightMaximum * (1 - fraction), language)}</text>}
          </g>;
        })}
        {averageY === null ? null : <line x1={STATISTICS_CHART_PLOT.left} x2={width - STATISTICS_CHART_PLOT.right} y1={averageY} y2={averageY} stroke={primarySeries?.color} strokeDasharray="5 4" strokeWidth="1.25" />}
        {primarySeries === undefined ? null : <path d={statisticsChartAreaPath(windows.map((window, index) => ({ at: window.windowStart, value: primarySeries.values[index] ?? null })), start, end, leftMaximum, width)} fill={primarySeries.color} fillOpacity="0.12" />}
        {series.map((line) => {
          const maximum = line.side === "right" ? rightMaximum : leftMaximum;
          const points = windows.map((window, index) => ({ at: window.windowStart, value: line.values[index] ?? null }));
          return <path key={line.name} d={statisticsChartLinePath(points, start, end, maximum, width)} fill="none" stroke={line.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
        })}
        {focusedX === null ? null : <line x1={focusedX} x2={focusedX} y1={STATISTICS_CHART_PLOT.top} y2={STATISTICS_CHART_PLOT.bottom} stroke="var(--text-2)" strokeDasharray="3 3" />}
        {focusedX === null || focusedY === null ? null : <circle cx={focusedX} cy={focusedY} r="4" fill={primarySeries?.color} stroke="var(--surface)" strokeWidth="2" />}
        <rect x={STATISTICS_CHART_PLOT.left} y={LANE_STRIP_TOP} width={plotWidth} height="50" rx="4" fill="var(--surface-depth)" />
        {statisticsChartAxisTicks(1, Math.min(8, Math.max(2, Math.floor(plotWidth / 130)))).map(({ fraction }) => {
          const x = STATISTICS_CHART_PLOT.left + plotWidth * fraction;
          const at = new Date(start + (end - start) * fraction).toISOString();
          return <g key={fraction}>
            <line x1={x} x2={x} y1={STATISTICS_CHART_PLOT.bottom} y2={STATISTICS_CHART_PLOT.bottom + 4} stroke="var(--text-3)" />
            <text x={x} y={STATISTICS_CHART_PLOT.bottom + 17} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"} fill="var(--text-3)" fontSize="11">{timeLabel(at, language)}</text>
          </g>;
        })}
        {markers.map(({ event, x, lane, color, label }) => {
          const y = STATISTICS_CHART_PLOT.bottom + 35 + lane * 20;
          const active = event.id === highlightedEventId;
          const accessibleLabel = `${label}: ${eventDetail(event, labels)} ${labels.at} ${timeLabel(event.at, language)}`;
          return <g
            key={event.id}
            className="statistics-chart__marker"
            role="button"
            tabIndex={0}
            aria-label={accessibleLabel}
            aria-pressed={active}
            aria-describedby={active ? "statistics-stream-marker-tooltip" : undefined}
            onMouseEnter={() => onHighlightEvent(event.id)}
            onMouseLeave={(pointerEvent) => { if (!pointerEvent.currentTarget.contains(document.activeElement)) onHighlightEvent(null); }}
            onFocus={() => onHighlightEvent(event.id)}
            onBlur={() => onHighlightEvent(null)}
            onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
              keyboardEvent.preventDefault();
              onHighlightEvent(active ? null : event.id);
            }}
          >
            <circle cx={x} cy={y} r="10" fill="var(--surface)" stroke={active ? "var(--brand)" : "var(--line-strong)"} strokeWidth="1.5" />
            <g fill={color} stroke={color}>{markerShape(event.type, x, y)}</g>
          </g>;
        })}
      </svg>
    </div>
    <div className="statistics-chart__legend" aria-label={labels.history}>
      {series.map((line) => <span key={line.name}><i style={{ borderColor: line.color }} />{line.name}</span>)}
      {averageLineValue === null ? null : <span><i className="is-dashed" style={{ borderColor: primarySeries?.color }} />Ø {valueLabel(averageLineValue, language)} {primarySeries?.unit}</span>}
      <span className="statistics-chart__legend-markers">
        {MARKER_TYPES.filter((type) => markers.some(({ event }) => event.type === type)).map((type) => <span key={type}>
          <i className={`statistics-inspector__event-marker statistics-inspector__event-marker--${type}`} />{labelForEvent({ type }, labels)}
        </span>)}
      </span>
    </div>
  </div>;
}
