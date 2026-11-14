import type { ModuleLanguage } from "../../contract";

const labels = {
  de: {
    elementLabel: "Wortzähler",
    description: "Zeigt die Stream- und Gesamtzahl eines Chatworts.",
    word: "Wort",
    label: "Beschriftung",
    show: "Anzeigen",
    stream: "Stream",
    total: "Gesamt",
    both: "Beides",
    preview: "Vorschau",
    invalidWord: "Bitte gib ein zählbares Einzelwort ein.",
  },
  en: {
    elementLabel: "Word counter",
    description: "Shows stream and total counts for a chat word.",
    word: "Word",
    label: "Label",
    show: "Show",
    stream: "Stream",
    total: "Total",
    both: "Both",
    preview: "Preview",
    invalidWord: "Enter one countable word.",
  },
} as const;

export const statisticsWordCounterLabels = (language: ModuleLanguage) => labels[language];
