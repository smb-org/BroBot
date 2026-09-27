import type { ModuleLanguage } from "../../contract";

export const raidTemplateVariableGroupLabels: Readonly<Record<ModuleLanguage, string>> = {
  de: "Raids",
  en: "Raids",
};

export const raidTemplateVariableCatalog = {
  de: {
    channel: { label: "Raid-Kanal", description: "Kanal, von dem der Raid kommt", sample: "samplechannel" },
    viewers: { label: "Raid-Zuschauer", description: "Anzahl der Personen im Raid", sample: "42" },
  },
  en: {
    channel: { label: "Raid channel", description: "Channel the raid came from", sample: "samplechannel" },
    viewers: { label: "Raid viewers", description: "Number of people in the raid", sample: "42" },
  },
} as const satisfies Readonly<Record<ModuleLanguage, Readonly<Record<string, { label: string; description: string; sample: string }>>>>;
