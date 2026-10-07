export interface TextBlockOverlayEditorTexts {
  label: string;
  description: string;
  moduleLabel: string;
  previewPlaceholder: string;
  loading: string;
  unavailable: string;
  empty: string;
  sampleValues: Readonly<Record<string, string>>;
}

export const textBlockOverlayEditorTexts: Record<"de" | "en", TextBlockOverlayEditorTexts> = {
  de: {
    label: "Textbaustein",
    description: "Zeigt einen Baustein aus der Textbibliothek, zeitgesteuert.",
    moduleLabel: "Textbibliothek",
    previewPlaceholder: "Textbaustein wählen",
    loading: "Textbausteine werden geladen …",
    unavailable: "Textbausteine konnten nicht geladen werden.",
    empty: "Noch keine Textbausteine vorhanden.",
    sampleValues: {
      "sun.set": "19:42", "sun.rise": "06:18", "sun.dusk": "20:15",
      "sun.set_in": "2 Std. 15 Min.", "sun.rise_in": "8 Std. 30 Min.",
      game: "Minecraft", title: "Ein gemütlicher Abend", live: "live", date: "27.09.2026", time: "20:15",
    },
  },
  en: {
    label: "Text block",
    description: "Shows a text library block on a schedule.",
    moduleLabel: "Text library",
    previewPlaceholder: "Choose a text block",
    loading: "Loading text blocks …",
    unavailable: "Text blocks could not be loaded.",
    empty: "No text blocks yet.",
    sampleValues: {
      "sun.set": "19:42", "sun.rise": "06:18", "sun.dusk": "20:15",
      "sun.set_in": "2 hr 15 min", "sun.rise_in": "8 hr 30 min",
      game: "Minecraft", title: "A cozy evening", live: "live", date: "2026-09-27", time: "20:15",
    },
  },
};
