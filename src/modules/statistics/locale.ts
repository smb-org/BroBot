/** Bilingual texts of the `!wort` chat command; only the `de` halves are German. */
export const wordCommandTexts = {
  description: {
    de: "Zeigt die Wortanzahl im aktuellen Stream und insgesamt an.",
    en: "Shows the word count for the current stream and in total.",
  },
  argumentHint: { de: "Das gezählte Wort.", en: "The word to look up." },
  unknownReply: (language: "de" | "en", word: string): string => language === "de"
    ? `${word} wurde noch nicht gezählt`
    : `${word} has not been counted yet`,
} as const;
