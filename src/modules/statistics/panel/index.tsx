import "./panel.css";

import { useEffect, useMemo, useState, type ReactElement } from "react";

import { EmptyState, Icon, ListDetail, LoadState, SubInspector } from "../../../dashboard/ui";
import { dashboardCommonTexts, dashboardTexts } from "../../../dashboard/locale";
import { useModulePagesQuery, useModuleQuery } from "../../../dashboard/data/module-query";
import { useChannelSettings } from "../../../dashboard/data/channel-settings";
import { browserTimeZone } from "../../../dashboard/ui/format-relative-time";
import type { ModulePanelProperties } from "../../contract";
import type { StatisticsStreamDetailResponse, StatisticsStreamEvent, StatisticsStreamListResponse, StatisticsStreamSummary } from "../contracts";
import { loadStatisticsStream, loadStatisticsStreams } from "./service";
import { statisticsPanelTexts } from "./locale";
import { StatisticsHistoryChart } from "./history-chart";
import { StatisticsTrendsPanel } from "./trends";
import { StatisticsWordsPanel } from "./words-panel";

const number = (value: number | null, language: "de" | "en", digits = 0): string => value === null
  ? "—"
  : new Intl.NumberFormat(language, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);

const dateParts = (value: string, language: "de" | "en", timeZone: string): { date: string; time: string } => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return { date: "—", time: "—" };
  const locale = language === "de" ? "de-DE" : "en-US";
  return {
    date: new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", timeZone }).format(date),
    time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(date),
  };
};

const fullDate = (value: string, language: "de" | "en", timeZone: string): string => {
  const date = new Date(value);
  const locale = language === "de" ? "de-DE" : "en-US";
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone }).format(date);
};

const timestampTitle = (value: string, language: "de" | "en", timeZone: string, fallbackLabel: string | null): string | undefined => {
  if (fallbackLabel === null) return undefined;
  const date = new Date(value);
  const locale = language === "de" ? "de-DE" : "en-US";
  return Number.isNaN(date.valueOf())
    ? fallbackLabel
    : `${new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone }).format(date)} · ${fallbackLabel}`;
};

const TimestampPlaceholder = ({ size }: { size: "row" | "date" | "time" }): ReactElement =>
  <span className={`statistics-streams__timestamp-placeholder statistics-streams__timestamp-placeholder--${size}`} aria-hidden="true" />;

const duration = (seconds: number, unit: string): string => {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}:${String(minutes).padStart(2, "0")} ${unit}`;
};

const eventText = (event: StatisticsStreamEvent, labels: ReturnType<typeof statisticsPanelTexts>, language: "de" | "en"): string => {
  if (event.type === "metadata") {
    const changes = [];
    if (event.oldCategory !== event.category) changes.push(`${labels.category}: ${event.oldCategory ?? "—"} → ${event.category ?? "—"}`);
    if (event.oldTitle !== event.title) changes.push(`${labels.title}: ${event.oldTitle ?? "—"} → ${event.title ?? "—"}`);
    return changes.join(" · ");
  }
  if (event.type === "clip") return event.text ?? event.clipId ?? labels.clip;
  if (event.type === "ad") return `${number(event.durationSeconds ?? 0, language)} s`;
  if (event.type === "drop") return `${number(event.durationSeconds ?? 0, language)} s`;
  if (event.type === "emoteSpike") return labels.emotesInWindow(number(event.emotes ?? 0, language));
  if (event.type === "raidIncoming" || event.type === "raidOutgoing") {
    const describe = event.type === "raidIncoming" ? labels.raidFrom : labels.raidTo;
    return describe(event.partnerName ?? "—", event.raidViewers ?? 0);
  }
  if (event.type === "offline") return labels.streamEnded;
  return labels.streamStarted;
};

/** Viewer count of the five-minute window the event falls into. */
const eventViewers = (windows: StatisticsStreamDetailResponse["windows"], at: string, language: "de" | "en", unit: string): string => {
  const moment = Date.parse(at);
  const viewers = windows.findLast(({ windowStart }) => Date.parse(windowStart) <= moment)?.viewerCount ?? null;
  return viewers === null ? "" : `${number(viewers, language)} ${unit}`;
};

const eventLabel = (event: StatisticsStreamEvent, labels: ReturnType<typeof statisticsPanelTexts>): string => {
  if (event.type === "start") return labels.start;
  if (event.type === "offline") return labels.offline;
  if (event.type === "metadata") return labels.metadata;
  if (event.type === "clip") return labels.clip;
  if (event.type === "ad") return labels.ad;
  if (event.type === "drop") return labels.drop;
  if (event.type === "raidIncoming") return labels.raidIncoming;
  if (event.type === "raidOutgoing") return labels.raidOutgoing;
  return labels.emoteSpike;
};

const StreamRow = ({ summary, active, language, timeZone, timeZoneFallbackLabel, labels, onSelect }: {
  summary: StatisticsStreamSummary;
  active: boolean;
  language: "de" | "en";
  timeZone: string | null;
  timeZoneFallbackLabel: string | null;
  labels: ReturnType<typeof statisticsPanelTexts>;
  onSelect: () => void;
}): ReactElement => {
  const start = timeZone === null ? null : dateParts(summary.startedAt, language, timeZone);
  const category = summary.categories[0] ?? labels.noCategory;
  const categorySuffix = summary.categories.length > 1 ? ` +${String(summary.categories.length - 1)}` : "";
  const accessibleName = [summary.title ?? labels.noTitle, ...(start === null ? [] : [start.date, start.time]), duration(summary.durationSeconds, labels.durationUnit), `${category}${categorySuffix}`, `${labels.averagePeakViewers} ${number(summary.averageViewers, language)}`].join(", ");
  return <li className="statistics-streams__item">
    <button type="button" className="statistics-streams__row" aria-label={accessibleName} aria-pressed={active} onClick={onSelect}>
      <span className="statistics-streams__row-date" title={timeZone === null ? undefined : timestampTitle(summary.startedAt, language, timeZone, timeZoneFallbackLabel)}>
        {start === null ? <TimestampPlaceholder size="row" /> : <>{start.date} · <span className="mono">{start.time}</span></>}
      </span>
      <span className="statistics-streams__row-viewers"><Icon name="eye" />{number(summary.averageViewers, language)}</span>
      <span className="statistics-streams__row-category">{category}{categorySuffix}</span>
      <span className="statistics-streams__row-duration mono">{duration(summary.durationSeconds, labels.durationUnit)}</span>
    </button>
  </li>;
};

const StreamInspector = ({ detail, language, timeZone, timeZoneFallbackLabel, labels, highlightedEventId, onHighlightEvent, onClose, refreshError, onRetry }: {
  detail: StatisticsStreamDetailResponse;
  language: "de" | "en";
  timeZone: string | null;
  timeZoneFallbackLabel: string | null;
  labels: ReturnType<typeof statisticsPanelTexts>;
  highlightedEventId: string | null;
  onHighlightEvent: (eventId: string | null) => void;
  onClose: () => void;
  refreshError: boolean;
  onRetry: () => void;
}): ReactElement => {
  const { summary } = detail;
  const peakTime = summary.peakAt === null
    ? "—"
    : timeZone === null ? <TimestampPlaceholder size="time" /> : dateParts(summary.peakAt, language, timeZone).time;
  const peakTimeTitle = summary.peakAt === null || timeZone === null
    ? undefined
    : timestampTitle(summary.peakAt, language, timeZone, timeZoneFallbackLabel);
  const messagesPerMinute = summary.durationSeconds <= 0 ? null : summary.messages / (summary.durationSeconds / 60);
  const metrics = [
    { label: labels.duration, value: duration(summary.durationSeconds, labels.durationUnit), sub: "" },
    { label: labels.averagePeakViewers, value: `${number(summary.averageViewers, language)} / ${number(summary.peakViewers, language)}`, sub: <>{labels.peakAt} <span title={peakTimeTitle}>{peakTime}</span></> },
    { label: labels.messages, value: number(summary.messages, language), sub: "" },
    { label: labels.messagesPerMinute, value: number(messagesPerMinute, language, 1), sub: "" },
    { label: labels.activeChatters, value: number(summary.averageActiveChatters, language), sub: "" },
    { label: labels.clips, value: number(summary.clips, language), sub: "" },
  ];

  const headingMeta = <div className="statistics-inspector__meta">
    {summary.categories.map((category) => <span key={category} className="statistics-inspector__chip">{category}</span>)}
    <span title={timeZone === null ? undefined : timestampTitle(summary.startedAt, language, timeZone, timeZoneFallbackLabel)}>
      {timeZone === null ? <TimestampPlaceholder size="date" /> : fullDate(summary.startedAt, language, timeZone)}
    </span>
    <span className="mono" title={timeZone === null ? undefined : timestampTitle(summary.startedAt, language, timeZone, timeZoneFallbackLabel)}>
      {timeZone === null ? <><TimestampPlaceholder size="time" /> – <TimestampPlaceholder size="time" /></> : <>{dateParts(summary.startedAt, language, timeZone).time} – {dateParts(summary.endedAt, language, timeZone).time}</>}
    </span>
  </div>;

  return <SubInspector
    ariaLabel={labels.streams}
    title={summary.title ?? labels.noTitle}
    identifier={summary.streamId}
    meta={headingMeta}
    className="statistics-inspector"
    closeLabel={dashboardCommonTexts(language).close}
    onClose={onClose}
  >
    <div className="statistics-inspector__refresh-status" aria-live="polite">
      {refreshError ? <div role="alert"><span>{labels.detailError}</span><button type="button" className="statistics-streams__older" onClick={onRetry}>{labels.retry}</button></div> : null}
    </div>
    <div className="statistics-inspector__kpis">
      {metrics.map(({ label, value, sub }) => <div className="statistics-inspector__kpi" key={label}>
        <span className="statistics-inspector__kpi-label">{label}</span>
        <strong className="statistics-inspector__kpi-value mono">{value}</strong>
        {typeof sub === "string" && sub.length === 0 ? null : <span className="statistics-inspector__kpi-sub">{sub}</span>}
      </div>)}
    </div>

    <section className="statistics-inspector__panel statistics-inspector__card" aria-label={labels.history}>
      <StatisticsHistoryChart
        summary={summary}
        windows={detail.windows}
        bitrateWindows={detail.bitrateWindows}
        events={detail.events}
        language={language}
        timeZone={timeZone}
        timeZoneFallbackLabel={timeZoneFallbackLabel}
        labels={labels}
        highlightedEventId={highlightedEventId}
        onHighlightEvent={onHighlightEvent}
      />
    </section>

    <section className="statistics-inspector__panel statistics-inspector__card statistics-inspector__events-panel" aria-label={labels.events}>
      <div className="statistics-inspector__panel-heading">
        <div>
          <h3>{labels.events}</h3>
          <span>{labels.eventCount(number(detail.events.length, language))}</span>
        </div>
      </div>
      {detail.events.length === 0 ? <p className="statistics-inspector__no-events">{labels.noEvents}</p> : <ul className="statistics-inspector__events" aria-label={labels.events}>
        {detail.events.map((event) => <li
          key={event.id}
          className="statistics-inspector__event"
          aria-label={`${eventLabel(event, labels)} ${eventText(event, labels, language)}`}
          data-highlighted={event.id === highlightedEventId ? "true" : "false"}
          onMouseEnter={() => onHighlightEvent(event.id)}
          onMouseLeave={() => onHighlightEvent(null)}
        >
          <span className={`statistics-inspector__event-marker statistics-inspector__event-marker--${event.type}`} aria-hidden="true" />
          {timeZone === null ? <span className="statistics-inspector__event-time mono"><TimestampPlaceholder size="time" /></span> : <time
            className="mono"
            dateTime={event.at}
            title={timestampTitle(event.at, language, timeZone, timeZoneFallbackLabel)}
          >{dateParts(event.at, language, timeZone).time}</time>}
          <strong>{eventLabel(event, labels)}</strong>
          <span className="statistics-inspector__event-text">{eventText(event, labels, language)}</span>
          <span className="statistics-inspector__event-viewers mono">{eventViewers(detail.windows, event.at, language, labels.viewer)}</span>
        </li>)}
      </ul>}
    </section>
  </SubInspector>;
};

export function StatisticsStreamsPanel({ channelId, language = "de" }: ModulePanelProperties): ReactElement {
  const labels = statisticsPanelTexts(language);
  const settingsQuery = useChannelSettings(channelId);
  const timeZone = settingsQuery.isError ? browserTimeZone() : settingsQuery.data?.timeZone ?? null;
  const timeZoneFallbackLabel = settingsQuery.isError ? dashboardTexts(language).streamManager.browserTimeZoneFallback : null;
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const [selectionClosed, setSelectionClosed] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 1280);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const listQuery = useModulePagesQuery(
    channelId,
    "statistics",
    "streams:pages",
    (cursor, signal) => loadStatisticsStreams(channelId, signal, cursor ?? undefined),
    (page: StatisticsStreamListResponse) => page.nextCursor,
  );

  useEffect(() => {
    const updateNarrow = (): void => { setNarrow(window.innerWidth < 1280); };
    window.addEventListener("resize", updateNarrow);
    return () => { window.removeEventListener("resize", updateNarrow); };
  }, []);

  const streams = useMemo(() => {
    const rows = new Map<string, StatisticsStreamSummary>();
    for (const page of listQuery.data?.pages ?? []) {
      for (const stream of page.streams) rows.set(stream.streamId, stream);
    }
    return [...rows.values()];
  }, [listQuery.data]);
  const hasOlder = listQuery.hasNextPage;
  const olderLoading = listQuery.isFetchingNextPage;
  const olderError = listQuery.isFetchNextPageError;
  const activeStreamId = selectedStreamId ?? (selectionClosed || narrow ? null : streams[0]?.streamId ?? null);

  const detailQuery = useModuleQuery(channelId, "statistics", `stream:${activeStreamId ?? "none"}`,
    (signal) => activeStreamId === null
      ? Promise.resolve(null)
      : loadStatisticsStream(channelId, activeStreamId, signal),
    { enabled: activeStreamId !== null });
  const detail = detailQuery.data;
  const selectStream = (streamId: string): void => {
    setSelectedStreamId(streamId);
    setSelectionClosed(false);
    setHighlightedEventId(null);
  };
  const closeInspector = (): void => {
    setSelectedStreamId(null);
    setSelectionClosed(true);
  };
  const loadOlder = (): void => {
    if (!hasOlder || listQuery.isFetching) return;
    void listQuery.fetchNextPage();
  };
  const reloadStreams = (): void => { void listQuery.refetch(); };
  const listStatus = streams.length > 0 ? "success" : listQuery.isLoading ? "loading" : listQuery.isError ? "error" : "empty";

  if (listStatus === "empty") {
    return <div className="statistics-streams__skeleton">
      <section className="statistics-streams__list" aria-label={labels.streams}>
        <header className="statistics-streams__list-header">
          <div><h2>{labels.streams}</h2><p>{labels.noneLoaded}</p></div>
          <button type="button" className="statistics-streams__older" disabled><Icon name="clock-hour-4" />{labels.older}</button>
        </header>
        <div className="statistics-streams__placeholder"><p><strong>{labels.emptyTitle}</strong></p><p>{labels.emptyDescription}</p></div>
      </section>
      <div className="statistics-streams__placeholder statistics-streams__placeholder--detail"><p>{labels.noSelection}</p></div>
    </div>;
  }
  if (listStatus === "loading" || listStatus === "error") {
    return <div className="statistics-streams__empty-wrap">
      {listStatus === "loading" ? <LoadState variant="panel-480" status="loading" loading={<span>{labels.loading}</span>} empty={null} error={null}>
        <span>{labels.loading}</span>
      </LoadState> : null}
      {listStatus === "error" ? <LoadState
        variant="panel-480"
        status="error"
        loading={null}
        empty={null}
        error={<EmptyState title={labels.loadError} description={labels.emptyDescription} />}
        queryError={{ message: labels.loadError, onRetry: reloadStreams }}
      >{null}</LoadState> : null}
    </div>;
  }

  const list = <section className="statistics-streams__list" aria-label={labels.streams}>
    <header className="statistics-streams__list-header">
      <div><h2>{labels.streams}</h2><p>{labels.loadedCount(number(streams.length, language))}</p></div>
      <div className="statistics-streams__list-status" aria-live="polite">
        {!hasOlder ? null : olderError ? <div className="statistics-streams__list-error" role="alert">
          <span>{labels.loadError}</span>
          <button type="button" className="statistics-streams__older" onClick={loadOlder}>{labels.retry}</button>
        </div> : <button type="button" className="statistics-streams__older" disabled={olderLoading || listQuery.isFetching} onClick={loadOlder}>
          <Icon name="clock-hour-4" />{olderLoading ? labels.loading : labels.older}
        </button>}
      </div>
    </header>
    <ul className="statistics-streams__rows">
      {streams.map((stream) => <StreamRow
        key={stream.streamId}
        summary={stream}
        language={language}
        timeZone={timeZone}
        timeZoneFallbackLabel={timeZoneFallbackLabel}
        labels={labels}
        active={stream.streamId === activeStreamId}
        onSelect={() => selectStream(stream.streamId)}
      />)}
    </ul>
  </section>;

  const inspector = activeStreamId === null ? null : detailQuery.isError && (detail === undefined || detail === null) ? <SubInspector
    ariaLabel={labels.detailError}
    title={labels.detailError}
    className="statistics-inspector statistics-inspector--loading"
    closeLabel={dashboardCommonTexts(language).close}
    onClose={closeInspector}
  >
    <EmptyState title={labels.detailError} description={labels.emptyDescription} />
    <button type="button" className="statistics-streams__older" onClick={() => { void detailQuery.refetch(); }}>{labels.retry}</button>
  </SubInspector> : detail === undefined || detail === null ? <SubInspector
    ariaLabel={labels.loadingDetail}
    title={labels.loadingDetail}
    className="statistics-inspector statistics-inspector--loading"
    closeLabel={dashboardCommonTexts(language).close}
    onClose={closeInspector}
  >
    <LoadState variant="panel-720" status="loading" loading={<span>{labels.loadingDetail}</span>} empty={null} error={null}>{null}</LoadState>
  </SubInspector> : <StreamInspector
    detail={detail}
    language={language}
    timeZone={timeZone}
    timeZoneFallbackLabel={timeZoneFallbackLabel}
    labels={labels}
    highlightedEventId={highlightedEventId}
    onHighlightEvent={setHighlightedEventId}
    onClose={closeInspector}
    refreshError={detailQuery.isError}
    onRetry={() => { void detailQuery.refetch(); }}
  />;

  return <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />;
}

const STATISTICS_PAGES: Readonly<Record<string, (properties: ModulePanelProperties) => ReactElement>> = {
  trends: (properties) => <StatisticsTrendsPanel {...properties} />,
  words: (properties) => <StatisticsWordsPanel {...properties} />,
};

export function StatisticsPanel(properties: ModulePanelProperties): ReactElement {
  return (STATISTICS_PAGES[properties.pageId ?? ""] ?? ((streams) => <StatisticsStreamsPanel {...streams} />))(properties);
}
