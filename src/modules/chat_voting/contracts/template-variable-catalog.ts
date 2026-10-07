import type { ModuleLanguage } from "../../contract";

export const chatVotingResultVariableCatalog = {
  de: {
    label: "Abstimmungsergebnis",
    description: "Beschriftungen, Stimmen und Prozentwerte der beendeten Abstimmung",
    sample: "Ja: 8 (67%) · Nein: 4 (33%)",
  },
  en: {
    label: "Voting result",
    description: "Option labels, vote counts, and percentages from the completed vote",
    sample: "Yes: 8 (67%) · No: 4 (33%)",
  },
} as const satisfies Readonly<Record<ModuleLanguage, { label: string; description: string; sample: string }>>;

export const chatVotingTitleVariableCatalog = {
  de: {
    label: "Abstimmungsfrage",
    description: "Die optionale Frage dieser Abstimmung",
    sample: "Was essen wir heute?",
  },
  en: {
    label: "Vote question",
    description: "The optional question for this vote",
    sample: "What should we eat today?",
  },
} as const satisfies Readonly<Record<ModuleLanguage, { label: string; description: string; sample: string }>>;

export const chatVotingOptionsVariableCatalog = {
  de: {
    label: "Abstimmungsoptionen",
    description: "Eingaben, mit denen Zuschauer abstimmen können",
    sample: "1 = Pizza, 2 = Burger, 3 = Döner",
  },
  en: {
    label: "Voting options",
    description: "The inputs viewers can use to vote",
    sample: "1 = Pizza, 2 = Burger, 3 = Kebab",
  },
} as const satisfies Readonly<Record<ModuleLanguage, { label: string; description: string; sample: string }>>;

export const chatVotingDurationVariableCatalog = {
  de: {
    label: "Abstimmungsdauer",
    description: "Die konfigurierte Dauer einer zeitbegrenzten Abstimmung; bei offenen Abstimmungen leer",
    sample: "2 Minuten",
  },
  en: {
    label: "Vote duration",
    description: "The configured duration of a time-limited vote; empty for open-ended votes",
    sample: "2 minutes",
  },
} as const satisfies Readonly<Record<ModuleLanguage, { label: string; description: string; sample: string }>>;
