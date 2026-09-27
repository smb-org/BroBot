import type { ModuleLanguage } from "../../contract";

export const MOON_TEMPLATE_VARIABLE_NAMES = [
  "moon.phase", "moon.illumination", "moon.rise", "moon.set", "moon.rise_in", "moon.set_in",
] as const;

export type MoonTemplateVariableName = (typeof MOON_TEMPLATE_VARIABLE_NAMES)[number];

export interface MoonTemplateVariableText {
  label: string;
  description: string;
  sample: string;
}

export const moonModuleCatalog: Readonly<Record<ModuleLanguage, {
  mandatoryReason: string;
  unavailableText: string;
  variableGroup: string;
  templateVariables: Readonly<Record<MoonTemplateVariableName, MoonTemplateVariableText>>;
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
    variableGroup: "Mond",
    templateVariables: {
      "moon.phase": { label: "Mondphase", description: "Aktuelle Mondphase.", sample: "Zunehmender Mond" },
      "moon.illumination": { label: "Mondbeleuchtung", description: "Beleuchteter Anteil der Mondscheibe als Prozentwert.", sample: "74" },
      "moon.rise": { label: "Mondaufgang", description: "Zeit des nächsten Mondaufgangs.", sample: "20:42" },
      "moon.set": { label: "Monduntergang", description: "Zeit des nächsten Monduntergangs.", sample: "08:15" },
      "moon.rise_in": { label: "Zeit bis Mondaufgang", description: "Zeit bis zum nächsten Mondaufgang.", sample: "2 Std. 15 Min." },
      "moon.set_in": { label: "Zeit bis Monduntergang", description: "Zeit bis zum nächsten Monduntergang.", sample: "8 Std. 30 Min." },
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
    variableGroup: "Moon",
    templateVariables: {
      "moon.phase": { label: "Moon phase", description: "Current lunar phase.", sample: "Waxing gibbous" },
      "moon.illumination": { label: "Moon illumination", description: "Illuminated portion of the lunar disc, as a percentage.", sample: "74" },
      "moon.rise": { label: "Moonrise", description: "Time of the next moonrise.", sample: "20:42" },
      "moon.set": { label: "Moonset", description: "Time of the next moonset.", sample: "08:15" },
      "moon.rise_in": { label: "Time until moonrise", description: "Time until the next moonrise.", sample: "2 hr 15 min" },
      "moon.set_in": { label: "Time until moonset", description: "Time until the next moonset.", sample: "8 hr 30 min" },
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
