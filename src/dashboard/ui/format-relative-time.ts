import type { DashboardLanguage } from "../locale";

export type RelativeTimeValue = Date | number | string;

const asDate = (value: RelativeTimeValue): Date => value instanceof Date ? value : new Date(value);

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const dateParts = (date: Date, timeZone: string): { day: number; month: number; year: number } => {
  const formatter = (zone: string): Intl.DateTimeFormat => new Intl.DateTimeFormat("en", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter(timeZone).formatToParts(date);
  } catch {
    parts = formatter("UTC").formatToParts(date);
  }
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return {
    day: Number(values.get("day")),
    month: Number(values.get("month")),
    year: Number(values.get("year")),
  };
};

const dayOrdinal = (date: Date, timeZone: string): number => {
  const parts = dateParts(date, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
};

/** Calendar-day distance between two instants in the supplied time zone. */
export const calendarDayOffset = (at: RelativeTimeValue, now: RelativeTimeValue, timeZone: string): number | null => {
  const date = asDate(at);
  const current = asDate(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return null;
  return dayOrdinal(date, timeZone) - dayOrdinal(current, timeZone);
};

/** Stable day-group key for a timestamp in the supplied time zone. */
export const calendarDayKey = (at: RelativeTimeValue, timeZone: string): string => {
  const date = asDate(at);
  if (Number.isNaN(date.getTime())) return String(at);
  const { year, month, day } = dateParts(date, timeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Formats a compact relative label and an exact channel-local timestamp. */
export const formatRelativeTime = (
  at: RelativeTimeValue,
  now: RelativeTimeValue,
  language: DashboardLanguage,
  timeZone: string,
): { label: string; exact: string } => {
  const date = asDate(at);
  const current = asDate(now);
  if (Number.isNaN(date.getTime())) {
    const fallback = String(at);
    return { label: fallback, exact: fallback };
  }

  let effectiveTimeZone = timeZone;
  try {
    new Intl.DateTimeFormat(language, { timeZone }).format(date);
  } catch {
    effectiveTimeZone = "UTC";
  }

  const exact = new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "shortOffset",
    timeZone: effectiveTimeZone,
  }).format(date);
  const difference = date.getTime() - current.getTime();
  if (!Number.isNaN(current.getTime()) && Math.abs(difference) < 6 * 60 * 60 * 1000) {
    const absoluteDifference = Math.abs(difference);
    const unit: Intl.RelativeTimeFormatUnit = absoluteDifference < 60_000
      ? "second"
      : absoluteDifference < 60 * 60 * 1000 ? "minute" : "hour";
    const divisor = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 60 * 60 * 1000;
    const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" })
      .format(Math.round(difference / divisor), unit);
    return { label: relative, exact };
  }

  const clock = new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: effectiveTimeZone,
  }).format(date);
  const dayOffset = calendarDayOffset(date, current, effectiveTimeZone);
  if (dayOffset === 0) return { label: clock, exact };
  const day = dayOffset === null
    ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: effectiveTimeZone }).format(date)
    : new Intl.DateTimeFormat(language, { weekday: "short", timeZone: effectiveTimeZone }).format(date);
  return { label: `${day} ${clock}`, exact };
};

