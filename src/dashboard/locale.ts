/** Gemeinsame Spracheinstellung des Panels. Mehrsprachigkeit ersetzt nur diese Stelle. */
export const panelLocale = "de-DE";

export const formatDatum = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(panelLocale, { dateStyle: "medium" }).format(date);
};

export const formatZeitpunkt = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(panelLocale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

export const formatZahl = (value: number): string => new Intl.NumberFormat(panelLocale).format(value);
