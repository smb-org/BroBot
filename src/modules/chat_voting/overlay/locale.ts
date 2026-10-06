import type { ModuleLanguage } from "../../contract";

const catalog = {
  de: {
    title: "Abstimmung",
    closed: "Ergebnis",
    editorLabel: "Abstimmungsergebnis",
    editorAddLabel: "Abstimmungsergebnis hinzufügen",
    editorModuleLabel: "Abstimmung",
    previewOptions: ["Option eins", "Option zwei", "Option drei"],
    more: "weitere",
    layout: "Darstellung",
    strip: "Leiste",
    bars: "Balken",
    showPercent: "Prozent anzeigen",
    hideAfterCloseSeconds: "Ergebnis ausblenden nach",
    seconds: "Sekunden",
    width: "Breite (px)",
  },
  en: {
    title: "Voting",
    closed: "Results",
    editorLabel: "Voting tally",
    editorAddLabel: "Add voting tally",
    editorModuleLabel: "Voting",
    previewOptions: ["Option one", "Option two", "Option three"],
    more: "more",
    layout: "Layout",
    strip: "Strip",
    bars: "Bars",
    showPercent: "Show percentages",
    hideAfterCloseSeconds: "Hide results after",
    seconds: "seconds",
    width: "Width (px)",
  },
} as const;

export const chatVotingOverlayLabels = (language: ModuleLanguage) => catalog[language];
