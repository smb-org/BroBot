import type { ModuleLanguage } from "../../contract";

const catalog = {
  de: {
    title: "Abstimmung",
    previewTitle: "Was essen wir heute?",
    closed: "Ergebnis",
    editorLabel: "Abstimmungsergebnis",
    editorDescription: "Live-Balken der laufenden Abstimmung.",
    editorModuleLabel: "Abstimmung",
    previewOptions: ["Option eins", "Option zwei", "Option drei"],
    more: "weitere",
    countdownRemaining: (time: string) => `Noch ${time}`,
    layout: "Darstellung",
    strip: "Leiste",
    bars: "Balken",
    showPercent: "Prozent anzeigen",
    showCountdown: "Countdown anzeigen",
    hideAfterCloseSeconds: "Ergebnis ausblenden nach",
    seconds: "Sekunden",
    width: "Breite (px)",
  },
  en: {
    title: "Voting",
    previewTitle: "What should we eat today?",
    closed: "Results",
    editorLabel: "Voting tally",
    editorDescription: "Live bars for the current vote.",
    editorModuleLabel: "Voting",
    previewOptions: ["Option one", "Option two", "Option three"],
    more: "more",
    countdownRemaining: (time: string) => `${time} remaining`,
    layout: "Layout",
    strip: "Strip",
    bars: "Bars",
    showPercent: "Show percentages",
    showCountdown: "Show countdown",
    hideAfterCloseSeconds: "Hide results after",
    seconds: "seconds",
    width: "Width (px)",
  },
} as const;

export const chatVotingOverlayLabels = (language: ModuleLanguage) => catalog[language];
