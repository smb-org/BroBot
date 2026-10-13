import { type ReactElement, type ReactNode, type RefCallback } from "react";

import { dashboardLanguage, dashboardTexts } from "../locale";
import { calendarDayKey, calendarDayOffset, formatRelativeTime, type RelativeTimeValue } from "./format-relative-time";

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
  timeZone: string;
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
  for (const row of rows) {
    const key = calendarDayKey(row.at, timeZone);
    const previous = days.at(-1);
    if (previous?.key === key) {
      previous.rows.push(row);
    } else {
      days.push({ key, label: dayLabel(row.at, now, timeZone, language), rows: [row] });
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
  emptyLabel,
  now = new Date(),
  selectedId,
  onSelect,
  rowRef,
  className = "",
}: DataTableProps<Row>): ReactElement {
  const language = dashboardLanguage();
  const texts = dashboardTexts(language);
  const days = tableDays(rows, now, timeZone, language);
  const count = columns.length + 1;
  const classes = ["data-table", className].filter(Boolean).join(" ");

  return <div className={classes}>
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
      {days.length === 0 ? <tbody><tr><td className="data-table__empty" colSpan={count}>{emptyLabel}</td></tr></tbody> : days.map((day) => (
        <tbody key={day.key}>
          <tr className="data-table__day-row"><th scope="rowgroup" colSpan={count}>{day.label}</th></tr>
          {day.rows.map((row) => {
            const formatted = formatRelativeTime(row.at, now, language, timeZone);
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
                  aria-label={formatted.exact}
                  title={formatted.exact}
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
