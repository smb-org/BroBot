import type { ModuleLanguage } from "../../contract";

export const SUN_TEMPLATE_VARIABLE_NAMES = [
  "sun.set", "sun.rise", "sun.dusk", "sun.set_in", "sun.rise_in",
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
  templateVariables: Readonly<Record<SunTemplateVariableName, SunTemplateVariableText>>;
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
    templateVariables: {
      "sun.set": { label: "Sonnenuntergang", description: "Uhrzeit des heutigen Sonnenuntergangs", sample: "18:42" },
      "sun.rise": { label: "Sonnenaufgang", description: "Uhrzeit des nächsten Sonnenaufgangs", sample: "06:18" },
      "sun.dusk": { label: "Ende der Dämmerung", description: "Ende der heutigen bürgerlichen Abenddämmerung", sample: "19:24" },
      "sun.set_in": { label: "Zeit bis Sonnenuntergang", description: "Verbleibende Zeit bis zum Sonnenuntergang", sample: "2 Std. 15 Min." },
      "sun.rise_in": { label: "Zeit bis Sonnenaufgang", description: "Verbleibende Zeit bis zum nächsten Sonnenaufgang", sample: "8 Std. 30 Min." },
    },
    durationUnits: { day: "Tag", days: "Tage", hour: "Std.", minute: "Min." },
  },
  en: {
    mandatoryReason: "The sun data source is required for text blocks to use sun times.",
    unavailableText: "Sun data is currently unavailable.",
    variableGroup: "Sun",
    templateVariables: {
      "sun.set": { label: "Sunset", description: "Time of today's sunset", sample: "18:42" },
      "sun.rise": { label: "Sunrise", description: "Time of the next sunrise", sample: "06:18" },
      "sun.dusk": { label: "End of dusk", description: "End of today's civil dusk", sample: "19:24" },
      "sun.set_in": { label: "Time until sunset", description: "Time remaining until sunset", sample: "2 h 15 min" },
      "sun.rise_in": { label: "Time until sunrise", description: "Time remaining until the next sunrise", sample: "8 h 30 min" },
    },
    durationUnits: { day: "day", days: "days", hour: "hr", minute: "min" },
  },
};
