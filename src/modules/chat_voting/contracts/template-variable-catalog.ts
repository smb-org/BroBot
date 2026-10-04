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
