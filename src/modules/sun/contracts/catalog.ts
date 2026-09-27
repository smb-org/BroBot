import type { ModuleLanguage } from "../../contract";

export const sunModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  unavailableText: string;
  durationUnits: {
    day: string;
    days: string;
    hour: string;
    minute: string;
  };
}>> = {
  de: {
    mandatoryReason: "Die Sonnendatenquelle wird benötigt, damit Textbausteine Sonnenzeiten verwenden können.",
    unavailableText: "Sonnendaten sind derzeit nicht verfügbar.",
    durationUnits: { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." },
  },
  en: {
    mandatoryReason: "The sun data source is required for text blocks to use sun times.",
    unavailableText: "Sun data is currently unavailable.",
    durationUnits: { day: "day", days: "days", hour: "hr", minute: "min" },
  },
};
