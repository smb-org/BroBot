import type { ModuleLanguage } from "../../contract";

export const timersQuickActionTexts = {
  name: { de: "Timer überspringen", en: "Skip next timer message" },
  paletteKeywords: ["timer", "skip timer", "timer überspringen", "nachricht überspringen"],
  noPlanned: { de: "Kein Timer hat einen geplanten nächsten Lauf.", en: "No timer has a planned next occurrence." },
  loading: { de: "Timer werden geladen …", en: "Loading timers…" },
  loadFailed: { de: "Timer konnten nicht geladen werden.", en: "Timers could not be loaded." },
  timerLabel: { de: "Timer", en: "Timer" },
  chooseTimer: { de: "Timer auswählen", en: "Choose a timer" },
  selectionRequired: { de: "Wähle einen Timer aus.", en: "Choose a timer." },
  chooseTimerHint: { de: "Wähle den Timer aus, dessen nächste Nachricht entfallen soll.", en: "Choose the timer whose next message to skip." },
  success: (nextTime: string | null): Readonly<Record<ModuleLanguage, string>> => nextTime === null
    ? { de: "Nächste Nachricht übersprungen.", en: "Next message skipped." }
    : { de: `Übersprungen · Nächster Lauf: ${nextTime}`, en: `Skipped · Next run: ${nextTime}` },
  alreadySkipped: { de: "Der nächste Lauf ist bereits übersprungen.", en: "The next occurrence is already skipped." },
  nothingPlanned: { de: "Für diesen Timer ist kein Lauf geplant.", en: "This timer has no planned occurrence." },
  notFound: { de: "Der Timer ist nicht mehr verfügbar.", en: "The timer is no longer available." },
  error: { de: "Die Timer-Nachricht konnte nicht übersprungen werden.", en: "The timer message could not be skipped." },
} as const;
