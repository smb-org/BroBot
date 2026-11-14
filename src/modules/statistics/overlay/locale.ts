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

const rankingLabels = {
  de: {
    elementLabel: "Wort-Rangliste",
    description: "Zeigt die häufigsten Chatwörter im Stream oder insgesamt.",
    defaultTitle: "Top-Wörter",
    scope: "Bereich",
    stream: "Stream",
    total: "Gesamt",
    count: "Anzahl der Wörter",
    title: "Titel",
    bars: "Balken anzeigen",
    preview: "Vorschau",
  },
  en: {
    elementLabel: "Word ranking",
    description: "Shows the most frequent chat words for a stream or all time.",
    defaultTitle: "Top words",
    scope: "Scope",
    stream: "Stream",
    total: "Total",
    count: "Word count",
    title: "Title",
    bars: "Show bars",
    preview: "Preview",
  },
} as const;

export const statisticsWordRankingLabels = (language: ModuleLanguage) => rankingLabels[language];
