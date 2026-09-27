import type { ModuleLanguage } from "../../contract";

export const SUN_TEMPLATE_VARIABLE_NAMES = [
  "sun.set", "sun.rise", "sun.dusk", "sun.dawn", "sun.dawn_in", "sun.noon", "sun.day_length",
  "sun.golden_hour", "sun.golden_hour_in", "sun.golden_hour_end", "sun.blue_hour", "sun.blue_hour_in",
  "sun.set_in", "sun.rise_in",
] as const;

export type SunTemplateVariableName = (typeof SUN_TEMPLATE_VARIABLE_NAMES)[number];

export interface SunTemplateVariableText {
  label: string;
  description: string;
  sample: string;
}

export const sunModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  unavailableText: string;
  variableGroup: string;
  eventTimes: Readonly<Record<"sunset" | "sunrise" | "golden_hour", string>>;
  templateVariables: Readonly<Record<SunTemplateVariableName, SunTemplateVariableText>>;
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
    variableGroup: "Sonne",
    eventTimes: { sunset: "Sonnenuntergang", sunrise: "Sonnenaufgang", golden_hour: "Beginn der goldenen Stunde" },
    templateVariables: {
      "sun.set": { label: "Sonnenuntergang", description: "Zeit des nächsten Sonnenuntergangs.", sample: "18:42" },
      "sun.rise": { label: "Sonnenaufgang", description: "Uhrzeit des nächsten Sonnenaufgangs", sample: "06:18" },
      "sun.dusk": { label: "Ende der Dämmerung", description: "Zeit der nächsten bürgerlichen Abenddämmerung bei −6° Sonnenhöhe.", sample: "19:24" },
      "sun.dawn": { label: "Morgendämmerung", description: "Zeit der nächsten bürgerlichen Morgendämmerung bei −6° Sonnenhöhe", sample: "05:10" },
      "sun.dawn_in": { label: "Zeit bis zur Morgendämmerung", description: "Zeit bis zur nächsten bürgerlichen Morgendämmerung", sample: "7 Std. 30 Min." },
      "sun.noon": { label: "Sonnenhöchststand", description: "Zeit des nächsten Sonnenhöchststands", sample: "12:31" },
      "sun.day_length": { label: "Tageslänge", description: "Tageslänge des aktuellen Ortsdatums im Format h:mm", sample: "12:34" },
      "sun.golden_hour": { label: "Goldene Stunde", description: "Beginn der aktuellen oder nächsten goldenen Stunde", sample: "06:00" },
      "sun.golden_hour_in": { label: "Zeit bis zur goldenen Stunde", description: "Zeit bis zum Beginn der aktuellen oder nächsten goldenen Stunde", sample: "2 Std. 15 Min." },
      "sun.golden_hour_end": { label: "Ende der goldenen Stunde", description: "Ende der aktuellen oder nächsten goldenen Stunde", sample: "06:48" },
      "sun.blue_hour": { label: "Blaue Stunde", description: "Beginn der aktuellen oder nächsten blauen Stunde", sample: "05:45" },
      "sun.blue_hour_in": { label: "Zeit bis zur blauen Stunde", description: "Zeit bis zum Beginn der aktuellen oder nächsten blauen Stunde", sample: "8 Std. 30 Min." },
      "sun.set_in": { label: "Zeit bis Sonnenuntergang", description: "Zeit bis zum nächsten Sonnenuntergang.", sample: "2 Std. 15 Min." },
      "sun.rise_in": { label: "Zeit bis Sonnenaufgang", description: "Zeit bis zum nächsten Sonnenaufgang.", sample: "8 Std. 30 Min." },
    },
    phases: { day: "Tag", night: "Nacht", golden_hour: "Goldene Stunde", blue_hour: "Blaue Stunde" },
    durationUnits: { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." },
  },
  en: {
    mandatoryReason: "The sun data source is required for text blocks to use sun times.",
    unavailableText: "Sun data is currently unavailable.",
    variableGroup: "Sun",
    eventTimes: { sunset: "Sunset", sunrise: "Sunrise", golden_hour: "Start of golden hour" },
    templateVariables: {
      "sun.set": { label: "Sunset", description: "Time of today's sunset", sample: "18:42" },
      "sun.rise": { label: "Sunrise", description: "Time of the next sunrise", sample: "06:18" },
      "sun.dusk": { label: "End of dusk", description: "Time of the next civil dusk at −6° solar altitude", sample: "19:24" },
      "sun.dawn": { label: "Dawn", description: "Time of the next civil dawn at −6° solar altitude", sample: "05:10" },
      "sun.dawn_in": { label: "Time until dawn", description: "Time until the next civil dawn", sample: "7 h 30 min" },
      "sun.noon": { label: "Solar noon", description: "Time of the next solar noon", sample: "12:31" },
      "sun.day_length": { label: "Day length", description: "Day length for the current location date, formatted as h:mm", sample: "12:34" },
      "sun.golden_hour": { label: "Golden hour", description: "Start of the current or next golden hour", sample: "06:00" },
      "sun.golden_hour_in": { label: "Time until golden hour", description: "Time until the start of the current or next golden hour", sample: "2 h 15 min" },
      "sun.golden_hour_end": { label: "End of golden hour", description: "End of the current or next golden hour", sample: "06:48" },
      "sun.blue_hour": { label: "Blue hour", description: "Start of the current or next blue hour", sample: "05:45" },
      "sun.blue_hour_in": { label: "Time until blue hour", description: "Time until the start of the current or next blue hour", sample: "8 h 30 min" },
      "sun.set_in": { label: "Time until sunset", description: "Time until the next sunset.", sample: "2 h 15 min" },
      "sun.rise_in": { label: "Time until sunrise", description: "Time until the next sunrise.", sample: "8 h 30 min" },
    },
    phases: { day: "Day", night: "Night", golden_hour: "Golden hour", blue_hour: "Blue hour" },
    durationUnits: { day: "day", days: "days", hour: "hr", minute: "min" },
  },
};
