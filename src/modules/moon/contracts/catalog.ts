import type { ModuleLanguage } from "../../contract";

export const moonModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  unavailableText: string;
  variableDescriptions: Readonly<Record<string, string>>;
  phases: Readonly<Record<string, string>>;
  durationUnits: {
    day: string;
    days: string;
    hour: string;
    minute: string;
  };
}>> = {
  de: {
    mandatoryReason: "Die Monddatenquelle wird benötigt, damit Textbausteine Mondphasen und Mondzeiten verwenden können.",
    unavailableText: "Monddaten sind derzeit nicht verfügbar.",
    variableDescriptions: {
      "moon.phase": "Aktuelle Mondphase.",
      "moon.illumination": "Beleuchteter Anteil der Mondscheibe als Prozentwert.",
      "moon.rise": "Zeit des nächsten Mondaufgangs.",
      "moon.set": "Zeit des nächsten Monduntergangs.",
      "moon.rise_in": "Zeit bis zum nächsten Mondaufgang.",
      "moon.set_in": "Zeit bis zum nächsten Monduntergang.",
    },
    phases: {
      new: "Neumond",
      waxing_crescent: "Zunehmende Sichel",
      first_quarter: "Erstes Viertel",
      waxing_gibbous: "Zunehmender Mond",
      full: "Vollmond",
      waning_gibbous: "Abnehmender Mond",
      last_quarter: "Letztes Viertel",
      waning_crescent: "Abnehmende Sichel",
    },
    durationUnits: { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." },
  },
  en: {
    mandatoryReason: "The moon data source is required for text blocks to use moon phases and moon times.",
    unavailableText: "Moon data is currently unavailable.",
    variableDescriptions: {
      "moon.phase": "Current lunar phase.",
      "moon.illumination": "Illuminated portion of the lunar disc, as a percentage.",
      "moon.rise": "Time of the next moonrise.",
      "moon.set": "Time of the next moonset.",
      "moon.rise_in": "Time until the next moonrise.",
      "moon.set_in": "Time until the next moonset.",
    },
    phases: {
      new: "New moon",
      waxing_crescent: "Waxing crescent",
      first_quarter: "First quarter",
      waxing_gibbous: "Waxing gibbous",
      full: "Full moon",
      waning_gibbous: "Waning gibbous",
      last_quarter: "Last quarter",
      waning_crescent: "Waning crescent",
    },
    durationUnits: { day: "day", days: "days", hour: "hr", minute: "min" },
  },
};
