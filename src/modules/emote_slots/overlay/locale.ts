import type { ModuleLanguage } from "../../contract";

const labels = {
  de: {
    elementLabel: "Slot",
    result: "Slot-Ergebnis",
    editorDescription: "Zeigt das letzte gebuchte Slot-Ergebnis im Overlay.",
    borderColor: "Rahmenfarbe",
    colorUnset: "Nicht gesetzt",
    colorClear: "Farbe entfernen",
    outcomes: { win: "Gewinn", loss: "Verlust", pair: "Einsatz zurück", jackpot: "Jackpot" },
    jackpot: "Jackpot",
  },
  en: {
    elementLabel: "Slot",
    result: "Slot result",
    editorDescription: "Shows the latest booked slot result in the overlay.",
    borderColor: "Border color",
    colorUnset: "Not set",
    colorClear: "Clear color",
    outcomes: { win: "Win", loss: "Loss", pair: "Stake returned", jackpot: "Jackpot" },
    jackpot: "Jackpot",
  },
} as const;

export const emoteSlotOverlayLabels = (language: ModuleLanguage) => labels[language];
