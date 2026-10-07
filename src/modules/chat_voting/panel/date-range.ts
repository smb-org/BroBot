import type { DashboardLanguage } from "../../../dashboard/locale";

const localeFor = (language: DashboardLanguage): string => (language === "de" ? "de-DE" : "en-US");

export const dateText = (value: string | null, language: DashboardLanguage): string => {
  if (value === null || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(localeFor(language), { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
};

export const timeText = (value: string, language: DashboardLanguage): string =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(new Date(value))
    : "—";

const yearlessDateText = (value: Date, language: DashboardLanguage): string =>
  new Intl.DateTimeFormat(localeFor(language), { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit" }).format(value);

const DAY_MS = 86_400_000;
const localDayNumber = (value: Date): number => Math.round(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / DAY_MS);

/**
 * Compact start/end labels for a closed vote. Same day: times only. Next day: full start, end time with
 * the localized next-day marker. Longer spans: both full dates.
 */
export const compactDateRange = (from: string, to: string, language: DashboardLanguage, nextDayMarker: string): [string, string] => {
  const start = new Date(from);
  const end = new Date(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return ["—", "—"];
  const days = localDayNumber(end) - localDayNumber(start);
  if (days === 0) return [timeText(from, language), timeText(to, language)];
  if (days === 1) return [yearlessDateText(start, language), `${timeText(to, language)} ${nextDayMarker}`];
  return [dateText(from, language), dateText(to, language)];
};
