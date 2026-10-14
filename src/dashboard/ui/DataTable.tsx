import { useEffect, useState, type ReactElement, type ReactNode, type RefCallback } from "react";

import { dashboardLanguage, dashboardTexts } from "../locale";
import { calendarDayKey, calendarDayOffset, formatRelativeTime, type RelativeTimeValue } from "./format-relative-time";
import { LoadStateLines } from "./LoadState";

const CLOCK_INTERVAL_MS = 30_000;

const useTableClock = (override?: Date): Date => {
  const [clock, setClock] = useState(() => override ?? new Date());

  useEffect(() => {
    if (override !== undefined) return;

    let timeout: number | undefined;
    let interval: number | undefined;
    const stop = (): void => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
      timeout = undefined;
      interval = undefined;
    };
    const tick = (): void => { setClock(new Date()); };
    const start = (): void => {
      stop();
      if (document.hidden) return;
      tick();
      const delay = CLOCK_INTERVAL_MS - (Date.now() % CLOCK_INTERVAL_MS);
      timeout = window.setTimeout(() => {
        tick();
        interval = window.setInterval(tick, CLOCK_INTERVAL_MS);
      }, delay);
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [override]);

  return override ?? clock;
};

interface DataTableRecord {
  id: string;
  at: RelativeTimeValue;
  moduleGroup: string;
}

interface DataTableColumn<Row extends DataTableRecord> {
  key: string;
  label: ReactNode;
  render: (row: Row) => ReactNode;
  width?: string;
  hideOnMobile?: boolean;
  moduleGroup?: boolean;
  className?: string;
}

interface DataTableDay<Row extends DataTableRecord> {
  key: string;
  label: string;
  rows: Row[];
}

interface DataTableProps<Row extends DataTableRecord> {
  ariaLabel: string;
  rows: readonly Row[];
  columns: readonly DataTableColumn<Row>[];
  timeZone: string | null;
  timeZoneFallbackLabel?: string;
  emptyLabel: string;
  now?: Date;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  rowRef?: (id: string) => RefCallback<HTMLElement>;
  className?: string;
}

const dayLabel = (
  at: RelativeTimeValue,
  now: Date,
  timeZone: string,
  language: ReturnType<typeof dashboardLanguage>,
): string => {
  const offset = calendarDayOffset(at, now, timeZone);
  const texts = dashboardTexts(language).streamManager;
  if (offset === 0) return texts.today;
  if (offset === -1) return texts.yesterday;
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime())
    ? String(at)
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone }).format(date);
};

const tableDays = <Row extends DataTableRecord>(
  rows: readonly Row[],
  now: Date,
  timeZone: string,
  language: ReturnType<typeof dashboardLanguage>,
): DataTableDay<Row>[] => {
  const days: DataTableDay<Row>[] = [];
  const dayByKey = new Map<string, DataTableDay<Row>>();
  for (const row of rows) {
    const key = calendarDayKey(row.at, timeZone);
    const existing = dayByKey.get(key);
    if (existing !== undefined) {
      existing.rows.push(row);
    } else {
      const day = { key, label: dayLabel(row.at, now, timeZone, language), rows: [row] };
      days.push(day);
      dayByKey.set(key, day);
    }
  }
  return days;
};

const columnClass = <Row extends DataTableRecord>(column: DataTableColumn<Row>): string => [
  "data-table__column",
  `data-table__column--${column.key}`,
  column.hideOnMobile === true ? "data-table__column--mobile-hidden" : "",
  column.className ?? "",
].filter(Boolean).join(" ");

export function DataTable<Row extends DataTableRecord>({
  ariaLabel,
  rows,
  columns,
  timeZone,
  timeZoneFallbackLabel,
  emptyLabel,
  now: nowOverride,
  selectedId,
  onSelect,
  rowRef,
  className = "",
}: DataTableProps<Row>): ReactElement {
  const now = useTableClock(nowOverride);
  const language = dashboardLanguage();
  const texts = dashboardTexts(language);
  const days = timeZone === null ? [] : tableDays(rows, now, timeZone, language);
  const count = columns.length + 1;
  const classes = ["data-table", className].filter(Boolean).join(" ");
  const utcDayCount = new Set(rows.map((row) => calendarDayKey(row.at, "UTC"))).size;
  const reservedDayCount = timeZone === null
    ? Math.min(rows.length, utcDayCount + 2)
    : Math.max(days.length, Math.min(rows.length, utcDayCount + 2));
  const reservedHeight = Math.max(420, rows.length * 40 + reservedDayCount * 28);

  if (timeZone === null) return <div className={`${classes} data-table__timezone-placeholder`} aria-hidden="true" style={{ minHeight: `${String(reservedHeight)}px` }}>
    <LoadStateLines rows={rows.length} height={40} gap={0} />
  </div>;

  return <div className={classes} style={{ minHeight: `${String(reservedHeight)}px` }}>
    <table className="table data-table__table" aria-label={ariaLabel}>
      <colgroup>
        <col className="data-table__column data-table__column--time" />
        {columns.map((column) => <col
          key={column.key}
          className={columnClass(column)}
          style={column.width === undefined ? undefined : { width: column.width }}
        />)}
      </colgroup>
      <thead>
        <tr>
          <th className="data-table__column data-table__column--time" scope="col">{texts.events.time}</th>
          {columns.map((column) => <th key={column.key} className={columnClass(column)} scope="col">{column.label}</th>)}
        </tr>
      </thead>
      {days.length === 0 ? <tbody><tr className="data-table__empty-row"><td className="data-table__empty" colSpan={count}>{emptyLabel}</td></tr></tbody> : days.map((day) => (
        <tbody key={day.key}>
          <tr className="data-table__day-row" role="row"><th scope="rowgroup" colSpan={count}>{day.label}</th></tr>
          {day.rows.map((row) => {
            const formatted = formatRelativeTime(row.at, now, language, timeZone);
            const exactLabel = timeZoneFallbackLabel === undefined
              ? formatted.exact
              : `${formatted.exact} · ${timeZoneFallbackLabel}`;
            const date = row.at instanceof Date ? row.at : new Date(row.at);
            return <tr
              key={row.id}
              ref={rowRef?.(row.id)}
              tabIndex={onSelect === undefined ? undefined : 0}
              aria-selected={onSelect === undefined ? undefined : selectedId === row.id}
              onClick={onSelect === undefined ? undefined : () => { onSelect(row.id); }}
              onKeyDown={onSelect === undefined ? undefined : (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                onSelect(row.id);
              }}
            >
              <td className="data-table__time-cell data-table__column data-table__column--time">
                <time
                  className="data-table__time mono"
                  aria-label={exactLabel}
                  title={exactLabel}
                  {...(Number.isNaN(date.getTime()) ? {} : { dateTime: date.toISOString() })}
                >{formatted.label}</time>
              </td>
              {columns.map((column) => <td key={column.key} className={columnClass(column)}>
                <span className={`data-table__cell-content${column.moduleGroup === true ? " data-table__cell-content--marked" : ""}`}>
                  {column.moduleGroup === true ? <span className="data-table__module-group" data-module-group={row.moduleGroup} aria-hidden="true" /> : null}
                  <span className="data-table__cell-value">{column.render(row)}</span>
                </span>
              </td>)}
            </tr>;
          })}
        </tbody>
      ))}
    </table>
  </div>;
}
