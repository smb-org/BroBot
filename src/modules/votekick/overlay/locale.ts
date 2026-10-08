import type { ModuleLanguage } from "../../contract";

const catalog = {
  de: {
    title: (target: string) => `Votekick · ${target}`,
    unknownTarget: "Unbekanntes Ziel",
    yes: "Ja",
    no: "Nein",
    needed: (threshold: number) => `Benötigt: ${String(threshold)} Netto-Ja-Stimmen`,
    outcome: { running: "Läuft", passed: "Bestanden", expired: "Abgelaufen", cancelled: "Abgebrochen", failed: "Fehlgeschlagen" },
    countdownRemaining: (time: string) => `Noch ${time}`,
    editorLabel: "Votekick-Ergebnis",
    editorDescription: "Live-Balken und Countdown der Votekick-Abstimmung.",
    editorModuleLabel: "Votekick",
    showCountdown: "Countdown anzeigen",
    hideAfterCloseSeconds: "Ergebnis ausblenden nach",
    seconds: "Sekunden",
  },
  en: {
    title: (target: string) => `Votekick · ${target}`,
    unknownTarget: "Unknown target",
    yes: "Yes",
    no: "No",
    needed: (threshold: number) => `Needed: ${String(threshold)} net yes votes`,
    outcome: { running: "Running", passed: "Passed", expired: "Expired", cancelled: "Cancelled", failed: "Failed" },
    countdownRemaining: (time: string) => `${time} remaining`,
    editorLabel: "Votekick result",
    editorDescription: "Live bars and countdown for the votekick ballot.",
    editorModuleLabel: "Votekick",
    showCountdown: "Show countdown",
    hideAfterCloseSeconds: "Hide results after",
    seconds: "seconds",
  },
} as const;

export const votekickOverlayLabels = (language: ModuleLanguage) => catalog[language];
