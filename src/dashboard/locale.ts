import { browserModuleLanguage, type ModuleLanguage } from "../modules/contract";

export type DashboardLanguage = ModuleLanguage;

/**
 * Die Sprache des Panels, abgeleitet aus dem Browser (Entscheidung 0007).
 * Dies ist die einzige Stelle, die sie bestimmt — eine spätere bewusste
 * Sprachwahl je Nutzer ersetzt nur diese Funktion.
 */
export const dashboardLanguage = (): DashboardLanguage => browserModuleLanguage();

export const formatDashboardDate = (
  value: string,
  options: Intl.DateTimeFormatOptions,
): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(dashboardLanguage(), options).format(date);
};

export const formatDatum = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium" });

export const formatZeitpunkt = (value: string): string =>
  formatDashboardDate(value, { dateStyle: "medium", timeStyle: "short" });

export const formatZahl = (value: number): string =>
  new Intl.NumberFormat(dashboardLanguage()).format(value);
