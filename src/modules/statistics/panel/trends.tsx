import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";

import { useModuleQuery } from "../../../dashboard/data/module-query";
import { Icon } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type {
  StatisticsTrendCategory,
  StatisticsTrendKpis,
  StatisticsTrendsResponse,
  StatisticsTrendsWeeks,
} from "../contracts";
import {
  STATISTICS_CHART_PLOT,
  statisticsChartAxisTicks,
  statisticsChartLinePath,
  statisticsChartScaleY,
} from "./chart-primitives";
import { loadStatisticsTrends } from "./service";
import { statisticsTrendsTexts } from "./locale";

const RANGES: readonly StatisticsTrendsWeeks[] = [4, 12, 52];
const CHART_HEIGHT = 244;
const TREND_PLOT = { left: 42, right: 42, top: 20, bottom: 196, width: STATISTICS_CHART_PLOT.width };

type CategorySort = "name" | "streams" | "hours" | "viewers" | "messages";
type SortDirection = "ascending" | "descending";

const localeFor = (language: "de" | "en"): string => language === "de" ? "de-DE" : "en-GB";

const numberText = (value: number | null, language: "de" | "en", digits = 0): string => value === null
  ? "—"
  : new Intl.NumberFormat(localeFor(language), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

const rangeDateText = (range: { start: string; end: string }, language: "de" | "en", timeZone: string): string => {
  const locale = localeFor(language);
  const start = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(new Date(range.start));
  const end = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone })
    .format(new Date(Date.parse(range.end) - 1));
  return `${start} – ${end}`;
};

const weekSpanText = (data: StatisticsTrendsResponse, language: "de" | "en"): string => {
  const first = data.weekly[0]?.isoWeek;
  const last = data.weekly.at(-1)?.isoWeek;
  if (first === undefined || last === undefined || first === last) return rangeDateText(data.range, language, data.timeZone);
  return `${statisticsTrendsTexts(language).weekPrefix} ${String(first)}–${String(last)} · ${rangeDateText(data.range, language, data.timeZone)}`;
};

const dateRangeSummary = (data: StatisticsTrendsResponse, language: "de" | "en"): string => {
  const texts = statisticsTrendsTexts(language);
  return texts.rangeSummary(weekSpanText(data, language), rangeDateText(data.previousRange, language, data.timeZone));
};

const metricDelta = (
  current: number | null,
  previous: number | null,
  language: "de" | "en",
): { percent: string; direction: "up" | "down" | "same" | "none"; previous: string } => {
  const texts = statisticsTrendsTexts(language);
  if ((current ?? 0) === 0 && (previous ?? 0) === 0) return { percent: "–", direction: "none", previous: "" };
  if (current === null || previous === null) {
    return { percent: texts.noPrevious, direction: "same", previous: "" };
  }
  const delta = current - previous;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "same";
  const previousText = texts.previous(numberText(previous, language, 1));
  // A zero base has no meaningful percentage.
  if (previous === 0) return { percent: texts.newPeriod, direction, previous: previousText };
  const percent = Math.abs(delta / previous) * 100;
  return {
    percent: `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${numberText(percent, language, 1)}${language === "de" ? " %" : "%"}`,
    direction,
    previous: previousText,
  };
};

const Delta = ({ current, previous, language }: { current: number | null; previous: number | null; language: "de" | "en" }): ReactElement => {
  const delta = metricDelta(current, previous, language);
  const iconName = delta.direction === "up" ? "trendUp" : delta.direction === "down" ? "trendDown" : "minus";
  return <span className="statistics-trends__delta">
    {delta.direction === "none" ? null : <Icon name={iconName} size={16} />}
    <span>{delta.percent}</span>
    {delta.previous.length === 0 ? null : <span>{delta.previous}</span>}
  </span>;
};

const Kpi = ({ label, value, unit, current, previous, language }: {
  label: string;
  value: string;
  unit?: string;
  current: number | null;
  previous: number | null;
  language: "de" | "en";
}): ReactElement => <article className="statistics-trends__kpi">
  <h3>{label}</h3>
  <p>{value}{unit === undefined ? null : <small>{unit}</small>}</p>
  <Delta current={current} previous={previous} language={language} />
</article>;

const WeekChart = ({ data, language, labels }: {
  data: StatisticsTrendsResponse;
  language: "de" | "en";
  labels: ReturnType<typeof statisticsTrendsTexts>;
}): ReactElement => {
  // A callback ref: the chart container comes and goes with the range, so the observer follows it.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(TREND_PLOT.width);
  const hasStreams = data.kpis.streams > 0;
  const viewerMaximum = Math.max(50, Math.ceil(Math.max(0, ...data.weekly.map(({ averageViewers }) => averageViewers ?? 0)) / 50) * 50);
  const hourMaximum = Math.max(15, Math.ceil(Math.max(0, ...data.weekly.map(({ streamHours }) => streamHours)) / 3) * 3);
  const band = Math.max(1, (width - TREND_PLOT.left - TREND_PLOT.right) / Math.max(1, data.weekly.length));
  const barWidth = Math.min(40, band * 0.56);
  const labelStride = Math.max(1, Math.ceil((band >= 58 ? 58 : 21) / band));
  const linePoints = data.weekly.map((week, index) => ({ at: index + 0.5, value: week.streamHours }));
  const linePath = statisticsChartLinePath(linePoints, 0, data.weekly.length, hourMaximum, width, TREND_PLOT);

  useEffect(() => {
    if (container === null) return;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? container.getBoundingClientRect().width;
      if (nextWidth > 0) setWidth(Math.max(260, Math.round(nextWidth)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);
  const viewerTicks = statisticsChartAxisTicks(viewerMaximum, 5);
  // Round away float noise (15 * 0.2 is not exactly 3) and use one precision for the whole axis.
  const hourTicks = viewerTicks.map(({ fraction }) => Math.round(hourMaximum * (1 - fraction) * 10) / 10);
  const hourDigits = hourTicks.every((value) => Number.isInteger(value)) ? 0 : 1;

  return <section className="statistics-trends__panel statistics-trends__weekly" aria-labelledby="statistics-trends-weekly-title">
    <div className="statistics-trends__panel-heading">
      <h2 id="statistics-trends-weekly-title">{labels.weeklyTitle}</h2>
      <p>{labels.weeklyDescription}</p>
    </div>
    {hasStreams ? <div className="statistics-trends__week-chart" ref={setContainer}>
      <svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${String(width)} ${String(CHART_HEIGHT)}`} role="img" aria-label={labels.weeklyTitle}>
        {viewerTicks.map(({ fraction, value }, tickIndex) => {
          const y = TREND_PLOT.top + (TREND_PLOT.bottom - TREND_PLOT.top) * fraction;
          return <g key={fraction}>
            <line x1={TREND_PLOT.left} x2={width - TREND_PLOT.right} y1={y} y2={y}
              stroke="var(--color-border)" strokeDasharray={fraction === 1 ? undefined : "2 4"} />
            <text x={TREND_PLOT.left - 8} y={y + 4} textAnchor="end" fill="var(--color-text-3)" fontSize="11">
              {numberText(value, language)}
            </text>
            <text x={width - TREND_PLOT.right + 8} y={y + 4} textAnchor="start" fill="var(--color-text-3)" fontSize="11">
              {numberText(hourTicks[tickIndex] ?? 0, language, hourDigits)}
            </text>
          </g>;
        })}
        {data.weekly.map((week, index) => {
          const center = TREND_PLOT.left + band * (index + 0.5);
          const height = week.averageViewers === null ? 0 : Math.max(1, TREND_PLOT.bottom - statisticsChartScaleY(week.averageViewers, viewerMaximum, TREND_PLOT.top, TREND_PLOT.bottom));
          const x = center - barWidth / 2;
          const y = TREND_PLOT.bottom - height;
          const noStreams = week.streamHours === 0;
          const visibleLabel = index % labelStride === 0 || index === data.weekly.length - 1;
          return <g key={week.weekStart}>
            {noStreams
              ? <rect x={x} y={TREND_PLOT.bottom - 14} width={barWidth} height="14" rx="3" fill="none" stroke="var(--color-border-strong)" strokeDasharray="3 3" />
              : week.averageViewers === null
                ? <rect x={x} y={TREND_PLOT.bottom - 2} width={barWidth} height="2" rx="1" fill="var(--color-border-strong)" />
                : <rect x={x} y={y} width={barWidth} height={height} rx="3" fill="var(--color-chart-1)" />}
            {week.averageViewers !== null && band >= 38 ? <text x={center} y={TREND_PLOT.bottom - 8} textAnchor="middle" fill="var(--color-depth)" fontSize="11">
              {numberText(week.averageViewers, language)}
            </text> : null}
            {visibleLabel ? <text x={center} y={TREND_PLOT.bottom + 18} textAnchor="middle" fill="var(--color-text-3)" fontSize="11">
              {band >= 58 ? `${labels.weekPrefix} ${String(week.isoWeek)}` : String(week.isoWeek)}
            </text> : null}
            <title>{`${labels.weekPrefix} ${String(week.isoWeek)} · ${numberText(week.averageViewers, language)} · ${numberText(week.streamHours, language, 1)} h`}</title>
          </g>;
        })}
        <path d={linePath} fill="none" stroke="var(--color-chart-5)" strokeWidth="2" strokeLinejoin="round" />
        {data.weekly.map((week, index) => {
          const cx = TREND_PLOT.left + band * (index + 0.5);
          const cy = statisticsChartScaleY(week.streamHours, hourMaximum, TREND_PLOT.top, TREND_PLOT.bottom);
          return <circle key={`hours:${week.weekStart}`} cx={cx} cy={cy} r="3.5" fill="var(--color-chart-5)" stroke="var(--color-inspector)" strokeWidth="1.5" />;
        })}
      </svg>
      <div className="statistics-trends__legend" aria-label={labels.weeklyTitle}>
        <span><i className="statistics-trends__legend-bar" />{labels.viewers} ({labels.leftAxis})</span>
        <span><i className="statistics-trends__legend-line" />{labels.hours} ({labels.rightAxis})</span>
        <span><i className="statistics-trends__legend-empty" />{labels.emptyWeek}</span>
      </div>
    </div> : <EmptyChart />}
  </section>;
};

const Heatmap = ({ data, language, labels }: {
  data: StatisticsTrendsResponse;
  language: "de" | "en";
  labels: ReturnType<typeof statisticsTrendsTexts>;
}): ReactElement => {
  const hasStreams = data.kpis.streams > 0;
  const firstObservedHour = data.heatmap.length === 0 ? 0 : Math.min(...data.heatmap.map(({ hour }) => hour));
  const lastObservedHour = data.heatmap.length === 0 ? 23 : Math.max(...data.heatmap.map(({ hour }) => hour));
  const hourStart = Math.floor(firstObservedHour / 12) * 12;
  const hourEnd = Math.max(Math.min(23, hourStart + 11), lastObservedHour);
  const hours = hasStreams && data.heatmap.length > 0
    ? Array.from({ length: hourEnd - hourStart + 1 }, (_, index) => hourStart + index)
    : [];
  const values = data.heatmap.flatMap(({ averageViewers }) => averageViewers === null ? [] : [averageViewers]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const formatter = new Intl.DateTimeFormat(localeFor(language), { weekday: "short", timeZone: "UTC" });
  const dayLabels = Array.from({ length: 7 }, (_, weekday) => formatter.format(new Date(Date.UTC(2024, 0, weekday + 1))));
  const cellByCoordinate = new Map(data.heatmap.map((cell) => [`${String(cell.weekday)}:${String(cell.hour)}`, cell]));
  const levelFor = (value: number | null): number => value === null || !Number.isFinite(minimum) || !Number.isFinite(maximum)
    ? 0
    : maximum === minimum ? 3 : Math.min(5, Math.floor((value - minimum) / (maximum - minimum) * 5) + 1);
  // Roving tabindex: one cell is in the tab order, the arrow keys move between cells.
  const cellElements = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const firstCell = data.heatmap[0];
  // Tab stop: the last focused cell while it exists, else the first cell with data, else the first cell.
  const defaultKey = firstCell === undefined ? `0:${String(hours[0] ?? 0)}` : `${String(firstCell.weekday)}:${String(firstCell.hour)}`;
  const rovingKey = focusKey !== null && hours.includes(Number(focusKey.split(":")[1])) ? focusKey : defaultKey;
  // Set when the focused cell is torn down; the effect below then moves focus to the new tab stop.
  const focusLost = useRef(false);
  useEffect(() => {
    if (!focusLost.current) return;
    focusLost.current = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    cellElements.current.get(rovingKey)?.focus();
  });
  const cellText = (weekday: number, hour: number): { name: string; detail: string } => {
    const day = dayLabels[weekday] ?? "";
    const cell = cellByCoordinate.get(`${String(weekday)}:${String(hour)}`);
    if (cell === undefined) {
      const name = labels.heatCellEmpty(day, hour);
      return { name, detail: name };
    }
    const name = labels.heatCell(day, hour, numberText(cell.averageViewers, language));
    return { name, detail: `${name} · ${String(cell.streams)} ${labels.streams}` };
  };
  // A detail line for a cell that no longer exists in the current grid is dropped.
  const detailAt = detailKey === null || !hours.includes(Number(detailKey.split(":")[1])) ? null : detailKey.split(":").map(Number);
  const detailText = detailAt === null ? "" : cellText(detailAt[0] ?? 0, detailAt[1] ?? 0).detail;
  const moveFocus = (event: KeyboardEvent<HTMLElement>, weekday: number, hour: number): void => {
    const steps: Readonly<Record<string, [number, number]>> = {
      ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
    };
    const lastHour = hours.at(-1) ?? hour;
    const first = hours[0] ?? hour;
    const target = event.key === "Home" ? [weekday, first]
      : event.key === "End" ? [weekday, lastHour]
        : (() => {
          const step = steps[event.key];
          return step === undefined ? null : [Math.min(6, Math.max(0, weekday + step[0])), Math.min(lastHour, Math.max(first, hour + step[1]))];
        })();
    if (target === null || target[0] === undefined || target[1] === undefined) return;
    event.preventDefault();
    cellElements.current.get(`${String(target[0])}:${String(target[1])}`)?.focus();
  };

  return <section className="statistics-trends__panel statistics-trends__heatmap" aria-labelledby="statistics-trends-heatmap-title">
    <div className="statistics-trends__panel-heading">
      <h2 id="statistics-trends-heatmap-title">{labels.heatmapTitle}</h2>
      <p>{labels.heatmapDescription}</p>
    </div>
    {hasStreams && hours.length > 0 ? <div className="statistics-trends__heatmap-body">
      <div className="statistics-trends__heatmap-grid" role="grid" aria-label={labels.heatmapTitle} data-dense={hours.length > 15} style={{ "--trend-columns": String(hours.length) } as CSSProperties}>
        <span aria-hidden="true" />
        {hours.map((hour) => <span className="statistics-trends__heat-hour" key={`hour:${String(hour)}`}>{String(hour).padStart(2, "0")}</span>)}
        {dayLabels.map((day, weekday) => <div className="statistics-trends__heat-row" role="row" key={day}>
          <span className="statistics-trends__heat-day" role="rowheader">{day}</span>
          {hours.map((hour) => {
            const key = `${String(weekday)}:${String(hour)}`;
            const cell = cellByCoordinate.get(key);
            return <span
              key={key}
              data-cell={key}
              ref={(element) => {
                if (element === null) return undefined;
                cellElements.current.set(key, element);
                return () => {
                  if (cellElements.current.get(key) === element) cellElements.current.delete(key);
                  if (document.activeElement === element) focusLost.current = true;
                };
              }}
              className={`statistics-trends__heat-cell${cell === undefined ? " is-empty" : ""}`}
              role="gridcell"
              tabIndex={key === rovingKey ? 0 : -1}
              aria-label={cellText(weekday, hour).name}
              data-level={cell === undefined ? 0 : levelFor(cell.averageViewers)}
              onFocus={() => { setFocusKey(key); setDetailKey(key); }}
              onBlur={() => { setDetailKey(null); }}
              onMouseEnter={() => { setDetailKey(key); }}
              onMouseLeave={() => {
                // Fall back to the focused cell's details when a cell still has focus.
                const focused = document.activeElement;
                setDetailKey(focused instanceof HTMLElement && focused.dataset.cell !== undefined ? focused.dataset.cell : null);
              }}
              onKeyDown={(event) => { moveFocus(event, weekday, hour); }}
            >{cell === undefined || hours.length > 15 ? null : numberText(cell.averageViewers, language)}</span>;
          })}
        </div>)}
      </div>
      <div className="statistics-trends__heatmap-scale">
        <span>{labels.viewers}</span>
        <span className="statistics-trends__heatmap-min">{numberText(Number.isFinite(minimum) ? minimum : 0, language)}</span>
        <span className="statistics-trends__scale-steps" aria-hidden="true">{[1, 2, 3, 4, 5].map((level) => <i key={level} data-level={level} />)}</span>
        <span className="statistics-trends__heatmap-max">{numberText(Number.isFinite(maximum) ? maximum : 0, language)}</span>
        <span className="statistics-trends__scale-empty"><i />{labels.noStream}</span>
      </div>
      <p className="statistics-trends__scale-description">{labels.minViewers} · {labels.maxViewers}</p>
      <p className="statistics-trends__heat-detail" aria-live="polite">{detailText}</p>
    </div> : <EmptyChart />}
  </section>;
};

/** Quiet dashed placeholder; the text is optional because the page banner already explains an empty period. */
const EmptyChart = ({ label }: { label?: string }): ReactElement => <div className="statistics-trends__empty" aria-hidden={label === undefined ? true : undefined}>
  {label === undefined ? null : <span>{label}</span>}
</div>;

const categorySortValue = (category: StatisticsTrendCategory, sort: CategorySort): string | number | null => {
  switch (sort) {
    case "name": return category.name;
    case "streams": return category.streams;
    case "hours": return category.streamHours;
    case "viewers": return category.averageViewers;
    case "messages": return category.messagesPerMinute;
  }
};

const sortedCategories = (categories: readonly StatisticsTrendCategory[], sort: CategorySort, direction: SortDirection): StatisticsTrendCategory[] =>
  [...categories].sort((left, right) => {
    const a = categorySortValue(left, sort);
    const b = categorySortValue(right, sort);
    if (a === null || b === null) return a === b ? left.name.localeCompare(right.name) : a === null ? 1 : -1;
    const comparison = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : Number(a) - Number(b);
    return comparison === 0 ? left.name.localeCompare(right.name) : direction === "ascending" ? comparison : -comparison;
  });

const CategoryTable = ({ categories, hasStreams, sort, direction, onSort, language, labels }: {
  categories: readonly StatisticsTrendCategory[];
  hasStreams: boolean;
  sort: CategorySort;
  direction: SortDirection;
  onSort: (sort: CategorySort) => void;
  language: "de" | "en";
  labels: ReturnType<typeof statisticsTrendsTexts>;
}): ReactElement => {
  const rows = useMemo(() => sortedCategories(categories, sort, direction), [categories, direction, sort]);
  const maxHours = Math.max(0, ...categories.map(({ streamHours }) => streamHours));
  const heading = labels.categoriesTitle(categories.length);
  const headers: readonly { id: CategorySort; label: string; mobile: string }[] = [
    { id: "name", label: labels.category, mobile: labels.categoryShort },
    { id: "streams", label: labels.categoryStreams, mobile: labels.categoryStreamsShort },
    { id: "hours", label: labels.categoryHours, mobile: labels.categoryHoursShort },
    { id: "viewers", label: labels.categoryViewers, mobile: labels.categoryViewersShort },
    { id: "messages", label: labels.categoryMessagesPerMinute, mobile: labels.categoryMessagesShort },
  ];

  return <section className="statistics-trends__panel statistics-trends__categories" aria-labelledby="statistics-trends-categories-title">
    <div className="statistics-trends__panel-heading">
      <h2 id="statistics-trends-categories-title">{labels.categories}</h2>
      <p>{heading}</p>
    </div>
    {rows.length === 0 ? <EmptyChart {...(hasStreams ? { label: labels.noCategories } : {})} /> : <div className="statistics-trends__table-wrap">
      <table aria-label={labels.categories}>
        <colgroup><col className="statistics-trends__column-name" /><col className="statistics-trends__column-streams" /><col className="statistics-trends__column-hours" /><col className="statistics-trends__column-viewers" /><col className="statistics-trends__column-messages" /></colgroup>
        <thead><tr>{headers.map((header) => <th key={header.id} scope="col" aria-sort={sort === header.id ? direction : "none"}>
          <button type="button" aria-label={header.label} onClick={() => { onSort(header.id); }}>
            <span className="statistics-trends__desktop-label">{header.label}</span>
            <span className="statistics-trends__mobile-label" aria-hidden="true">{header.mobile}</span>
            <span className="statistics-trends__sort-icon" aria-hidden="true">{sort === header.id
              ? <Icon name={direction === "ascending" ? "sortAscending" : "sortDescending"} size={16} />
              : <Icon name="sort" size={16} />}</span>
          </button>
        </th>)}</tr></thead>
        <tbody>{rows.map((category) => <tr key={category.name}>
          <th scope="row" title={category.name}>{category.name}</th>
          <td>{numberText(category.streams, language)}</td>
          <td>
            <span className="statistics-trends__hours-cell">
              <i aria-hidden="true" style={{ width: `${String(maxHours === 0 ? 0 : Math.max(4, category.streamHours / maxHours * 100))}%` }} />
              <span>{numberText(category.streamHours, language, 1)}</span>
            </span>
          </td>
          <td>{numberText(category.averageViewers, language)}</td>
          <td>{numberText(category.messagesPerMinute, language, 1)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
};

const LoadingShell = (): ReactElement => <div className="statistics-trends__loading" aria-hidden="true">
  <div className="statistics-trends__kpis">{[1, 2, 3, 4].map((item) => <div className="statistics-trends__loading-kpi" key={item} />)}</div>
  <div className="statistics-trends__charts"><div /><div /></div>
  <div className="statistics-trends__loading-table" />
</div>;

export const StatisticsTrendsPanel = ({ channelId, language = "de" }: ModulePanelProperties): ReactElement => {
  const [weeks, setWeeks] = useState<StatisticsTrendsWeeks>(12);
  const [sort, setSort] = useState<CategorySort>("hours");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const labels = statisticsTrendsTexts(language);
  const query = useModuleQuery(
    channelId,
    "statistics",
    `trends:${String(weeks)}`,
    (signal) => loadStatisticsTrends(channelId, weeks, signal),
  );
  // Keep the last loaded range on screen while the next one loads; only the first load shows a skeleton.
  const [shown, setShown] = useState<StatisticsTrendsResponse | undefined>(query.data);
  if (query.data !== undefined && query.data !== shown) setShown(query.data);
  const data = query.data ?? shown;
  const pending = query.data === undefined && shown !== undefined && !query.isError;
  const sortBy = (nextSort: CategorySort): void => {
    if (nextSort === sort) setDirection((value) => value === "ascending" ? "descending" : "ascending");
    else {
      setSort(nextSort);
      setDirection(nextSort === "name" ? "ascending" : "descending");
    }
  };
  const current: StatisticsTrendKpis = data?.kpis ?? { streams: 0, streamHours: 0, averageViewers: null, messagesPerMinute: null };
  const previous: StatisticsTrendKpis = data?.previousKpis ?? { streams: 0, streamHours: 0, averageViewers: null, messagesPerMinute: null };

  return <div className="statistics-trends" aria-busy={query.isLoading} data-pending={pending ? "true" : "false"}>
    <header className="statistics-trends__toolbar">
      <p role={query.isError ? "alert" : undefined} className={query.isError ? "statistics-trends__error" : undefined}>{query.isError
        ? <>{data === undefined ? null : <span>{dateRangeSummary(data, language)} · </span>}{labels.loadError} <button type="button" onClick={() => { void query.refetch(); }}>{labels.retry}</button></>
        : data === undefined ? <span className="statistics-trends__date-placeholder" aria-hidden="true" /> : dateRangeSummary(data, language)}</p>
      <div className="statistics-trends__controls">
        <span className="statistics-trends__pending" role="status" aria-label={pending ? labels.updating : undefined}>
          {pending ? <Icon name="reload" size={16} /> : null}
        </span>
        <div className="statistics-trends__ranges" role="group" aria-label={labels.rangeSwitch}>
          {RANGES.map((range) => <button type="button" key={range} aria-pressed={weeks === range} onClick={() => { setWeeks(range); }}>
            {labels.weeks(range)}
          </button>)}
        </div>
      </div>
    </header>
    {data === undefined ? <LoadingShell /> : <>
      <section className="statistics-trends__kpis" aria-label={labels.kpis}>
        <Kpi label={labels.streams} value={numberText(current.streams, language)} current={current.streams} previous={previous.streams} language={language} />
        <Kpi label={labels.streamHours} value={numberText(current.streamHours, language, 1)} unit="h" current={current.streamHours} previous={previous.streamHours} language={language} />
        <Kpi label={labels.averageViewers} value={numberText(current.averageViewers, language)} current={current.averageViewers} previous={previous.averageViewers} language={language} />
        <Kpi label={labels.messagesPerMinute} value={numberText(current.messagesPerMinute, language, 1)} current={current.messagesPerMinute} previous={previous.messagesPerMinute} language={language} />
      </section>
      {current.streams === 0 ? <p className="statistics-trends__empty-period"><strong>{labels.noStreamsInPeriod}</strong><span>{labels.noStreamsDescription}</span></p> : null}
      <div className="statistics-trends__charts">
        <WeekChart data={data} language={language} labels={labels} />
        <Heatmap data={data} language={language} labels={labels} />
      </div>
      <CategoryTable categories={data.categories} hasStreams={current.streams > 0} sort={sort} direction={direction} onSort={sortBy} language={language} labels={labels} />
    </>}
  </div>;
};
