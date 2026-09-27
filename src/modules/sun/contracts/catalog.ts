import type { ModuleLanguage } from "../../contract";

export const sunModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  unavailableText: string;
  variableDescriptions: Readonly<Record<string, string>>;
  phases: Readonly<Record<"day" | "night" | "golden_hour" | "blue_hour", string>>;
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
    variableDescriptions: {
      "sun.set": "Zeit des nächsten Sonnenuntergangs.",
      "sun.set_in": "Zeit bis zum nächsten Sonnenuntergang.",
      "sun.rise": "Zeit des nächsten Sonnenaufgangs.",
      "sun.rise_in": "Zeit bis zum nächsten Sonnenaufgang.",
      "sun.dawn": "Zeit der nächsten bürgerlichen Morgendämmerung bei −6° Sonnenhöhe.",
      "sun.dawn_in": "Zeit bis zur nächsten bürgerlichen Morgendämmerung.",
      "sun.dusk": "Zeit der nächsten bürgerlichen Abenddämmerung bei −6° Sonnenhöhe.",
      "sun.noon": "Zeit des nächsten Sonnenhöchststands.",
      "sun.day_length": "Tageslänge des aktuellen Ortsdatums im Format h:mm.",
      "sun.golden_hour": "Beginn der aktuellen oder nächsten goldenen Stunde.",
      "sun.golden_hour_in": "Zeit bis zum Beginn der aktuellen oder nächsten goldenen Stunde.",
      "sun.golden_hour_end": "Ende der aktuellen oder nächsten goldenen Stunde.",
      "sun.blue_hour": "Beginn der aktuellen oder nächsten blauen Stunde.",
      "sun.blue_hour_in": "Zeit bis zum Beginn der aktuellen oder nächsten blauen Stunde.",
    },
    phases: { day: "Tag", night: "Nacht", golden_hour: "Goldene Stunde", blue_hour: "Blaue Stunde" },
    durationUnits: { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." },
  },
  en: {
    mandatoryReason: "The sun data source is required for text blocks to use sun times.",
    unavailableText: "Sun data is currently unavailable.",
    variableDescriptions: {
      "sun.set": "Time of the next sunset.",
      "sun.set_in": "Time until the next sunset.",
      "sun.rise": "Time of the next sunrise.",
      "sun.rise_in": "Time until the next sunrise.",
      "sun.dawn": "Time of the next civil dawn at −6° solar altitude.",
      "sun.dawn_in": "Time until the next civil dawn.",
      "sun.dusk": "Time of the next civil dusk at −6° solar altitude.",
      "sun.noon": "Time of the next solar noon.",
      "sun.day_length": "Day length for the current location date, formatted as h:mm.",
      "sun.golden_hour": "Start of the current or next golden hour.",
      "sun.golden_hour_in": "Time until the start of the current or next golden hour.",
      "sun.golden_hour_end": "End of the current or next golden hour.",
      "sun.blue_hour": "Start of the current or next blue hour.",
      "sun.blue_hour_in": "Time until the start of the current or next blue hour.",
    },
    phases: { day: "Day", night: "Night", golden_hour: "Golden hour", blue_hour: "Blue hour" },
    durationUnits: { day: "day", days: "days", hour: "hr", minute: "min" },
  },
};
