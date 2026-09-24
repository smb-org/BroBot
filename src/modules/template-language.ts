import type { ModuleLanguage } from "./contract";

interface TemplateLanguageText {
  offline: string;
  notFollowing: string;
  day: (count: number) => string;
  hour: (count: number) => string;
  minute: (count: number) => string;
  year: (count: number) => string;
  month: (count: number) => string;
  duration: (days: string, hours: string, minutes: string) => string;
  elapsed: (years: string, months: string) => string;
}

/** Bilingual text used to render system variables in the channel language. */
export const templateLanguageText: Readonly<Record<ModuleLanguage, TemplateLanguageText>> = {
  de: {
    offline: "offline",
    notFollowing: "folgt nicht",
    day: (count) => `${String(count)} Tg.`,
    hour: (count) => `${String(count)} Std.`,
    minute: (count) => `${String(count)} Min.`,
    year: (count) => `${String(count)} ${count === 1 ? "Jahr" : "Jahre"}`,
    month: (count) => `${String(count)} ${count === 1 ? "Monat" : "Monate"}`,
    duration: (days, hours, minutes) => `${days.length === 0 ? "" : `${days} `}${hours} ${minutes}`,
    elapsed: (years, months) => `${years}${months.length === 0 || years.length === 0 ? "" : ", "}${months}`,
  },
  en: {
    offline: "offline",
    notFollowing: "not following",
    day: (count) => `${String(count)} d`,
    hour: (count) => `${String(count)} h`,
    minute: (count) => `${String(count)} min`,
    year: (count) => `${String(count)} ${count === 1 ? "year" : "years"}`,
    month: (count) => `${String(count)} ${count === 1 ? "month" : "months"}`,
    duration: (days, hours, minutes) => `${days.length === 0 ? "" : `${days} `}${hours} ${minutes}`,
    elapsed: (years, months) => `${years}${months.length === 0 || years.length === 0 ? "" : ", "}${months}`,
  },
};
