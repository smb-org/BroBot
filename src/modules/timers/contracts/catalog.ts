import type { ModuleLanguage } from "../../contract";

export const timersModuleCatalog = {
  de: {
    label: "Timer",
    description: "Geplante Textbausteine für den Kanal verwalten.",
  },
  en: {
    label: "Timers",
    description: "Manage scheduled text blocks for this channel.",
  },
} as const satisfies Readonly<Record<ModuleLanguage, { label: string; description: string }>>;
