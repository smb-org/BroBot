import type { ModuleLanguage } from "../contract";

export const textLibraryModuleCatalog: Readonly<Record<ModuleLanguage, {
  label: string;
  description: string;
  mandatoryReason: string;
}>> = {
  de: {
    label: "Texte",
    description: "Wiederverwendbare Textbausteine für Befehle und Ereignisse.",
    mandatoryReason: "Die Textbibliothek ist immer verfügbar.",
  },
  en: {
    label: "Texts",
    description: "Reusable text blocks for commands and events.",
    mandatoryReason: "The text library is always available.",
  },
};
