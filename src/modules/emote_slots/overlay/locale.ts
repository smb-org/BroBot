import type { ModuleLanguage } from "../../contract";

const labels = {
  de: {
    elementLabel: "Slot",
    result: "Slot-Ergebnis",
    editorDescription: "Zeigt das letzte gebuchte Slot-Ergebnis im Overlay.",
    outcomes: { win: "Gewinn", loss: "Verlust", pair: "Einsatz zurück", jackpot: "Jackpot" },
    jackpot: "Jackpot",
    backgroundColor: "Hintergrundfarbe",
    textColor: "Textfarbe",
    secondaryColor: "Sekundärtextfarbe",
    highlightColor: "Jackpot-Hervorhebungsfarbe",
    contrastGood: (ratio: string) => `Textkontrast ${ratio}:1 · mindestens 4,5:1`,
    contrastWarning: (ratio: string) => `Textkontrast ${ratio}:1 · mindestens 4,5:1 erforderlich`,
    editorNote: "Der Slot-Balken nutzt Inhaltsfarben mit einem eigenen, deckenden Hintergrund.",
  },
  en: {
    elementLabel: "Slot",
    result: "Slot result",
    editorDescription: "Shows the latest booked slot result in the overlay.",
    outcomes: { win: "Win", loss: "Loss", pair: "Stake returned", jackpot: "Jackpot" },
    jackpot: "Jackpot",
    backgroundColor: "Background color",
    textColor: "Text color",
    secondaryColor: "Secondary text color",
    highlightColor: "Jackpot highlight color",
    contrastGood: (ratio: string) => `Text contrast ${ratio}:1 · minimum 4.5:1`,
    contrastWarning: (ratio: string) => `Text contrast ${ratio}:1 · at least 4.5:1 is required`,
    editorNote: "The slot bar uses content colors on its own opaque background.",
  },
} as const;

export const emoteSlotOverlayLabels = (language: ModuleLanguage) => labels[language];
