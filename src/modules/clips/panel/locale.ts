import type { LocaleCatalog } from "../../../dashboard/locale";

interface ClipsActionTexts {
  title: string;
  create: string;
  created: string;
  open: string;
  opensNewTab: string;
  failed: string;
}

const actionCatalog: LocaleCatalog<ClipsActionTexts> = {
  de: {
    title: "Clip",
    create: "Clip erstellen",
    created: "Clip erstellt",
    open: "Clip öffnen",
    opensNewTab: "öffnet neuen Tab",
    failed: "Der Clip konnte nicht erstellt werden.",
  },
  en: {
    title: "Clip",
    create: "Create clip",
    created: "Clip created",
    open: "Open clip",
    opensNewTab: "opens a new tab",
    failed: "The clip could not be created.",
  },
};

export const clipsActionTexts = (language: "de" | "en"): ClipsActionTexts => actionCatalog[language];
