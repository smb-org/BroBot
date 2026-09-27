import type { ModuleLanguage } from "../../contract";

export const adsTemplateVariableGroupLabels: Readonly<Record<ModuleLanguage, string>> = {
  de: "Werbung",
  en: "Ad breaks",
};

export const adsTemplateVariableCatalog = {
  de: {
    "ads.duration": { label: "Werbedauer", description: "Länge der laufenden Werbepause", sample: "90 s" },
    "ads.seconds": { label: "Sekunden bis zur Werbung", description: "Sekunden bis zum Start der Werbepause", sample: "45" },
  },
  en: {
    "ads.duration": { label: "Ad duration", description: "Length of the current ad break", sample: "90 s" },
    "ads.seconds": { label: "Seconds until ads", description: "Seconds until the ad break starts", sample: "45" },
  },
} as const satisfies Readonly<Record<ModuleLanguage, Readonly<Record<string, { label: string; description: string; sample: string }>>>>;
