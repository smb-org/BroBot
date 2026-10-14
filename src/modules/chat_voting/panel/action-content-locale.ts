import type { ModuleLanguage } from "../../contract";

interface ChatVotingActionContentTexts {
  label: Readonly<Record<ModuleLanguage, string>>;
  loading: Readonly<Record<ModuleLanguage, string>>;
  savedUnavailable: Readonly<Record<ModuleLanguage, string>>;
  empty: Readonly<Record<ModuleLanguage, string>>;
  choose: Readonly<Record<ModuleLanguage, string>>;
  mode: Readonly<Record<ModuleLanguage, string>>;
  saved: Readonly<Record<ModuleLanguage, string>>;
  adHoc: Readonly<Record<ModuleLanguage, string>>;
  kind: Readonly<Record<ModuleLanguage, string>>;
  yesNo: Readonly<Record<ModuleLanguage, string>>;
  multipleChoice: Readonly<Record<ModuleLanguage, string>>;
  title: Readonly<Record<ModuleLanguage, string>>;
  titlePlaceholder: Readonly<Record<ModuleLanguage, string>>;
  options: Readonly<Record<ModuleLanguage, string>>;
  optionNumber: Readonly<Record<ModuleLanguage, (number: number) => string>>;
  optionPlaceholder: Readonly<Record<ModuleLanguage, (number: number) => string>>;
  addOption: Readonly<Record<ModuleLanguage, string>>;
  remove: Readonly<Record<ModuleLanguage, string>>;
  removeOption: Readonly<Record<ModuleLanguage, (number: number) => string>>;
  duration: Readonly<Record<ModuleLanguage, string>>;
  oneMinute: Readonly<Record<ModuleLanguage, string>>;
  twoMinutes: Readonly<Record<ModuleLanguage, string>>;
  fiveMinutes: Readonly<Record<ModuleLanguage, string>>;
  preview: Readonly<Record<ModuleLanguage, string>>;
  previewQuestion: Readonly<Record<ModuleLanguage, string>>;
  previewHint: Readonly<Record<ModuleLanguage, string>>;
  bot: Readonly<Record<ModuleLanguage, string>>;
  yes: Readonly<Record<ModuleLanguage, string>>;
  no: Readonly<Record<ModuleLanguage, string>>;
  characterCount: Readonly<Record<ModuleLanguage, (count: number, maxLength: number) => string>>;
}

export const chatVotingActionContentTexts = {
  label: { de: "Abstimmung", en: "Vote" },
  loading: { de: "Abstimmungen werden geladen …", en: "Loading votes …" },
  savedUnavailable: { de: "Gespeicherte Abstimmungen konnten nicht geladen werden.", en: "Saved votes could not be loaded." },
  empty: { de: "Keine gespeicherten Abstimmungen vorhanden.", en: "No saved votes are available." },
  choose: { de: "Abstimmung auswählen", en: "Choose a vote" },
  mode: { de: "Vorlage", en: "Vote setup" },
  saved: { de: "Gespeichert", en: "Saved" },
  adHoc: { de: "Direkt erstellen", en: "Create now" },
  kind: { de: "Antworttyp", en: "Answer type" },
  yesNo: { de: "Ja / Nein", en: "Yes / No" },
  multipleChoice: { de: "Auswahl", en: "Multiple choice" },
  title: { de: "Frage", en: "Question" },
  titlePlaceholder: { de: "Worüber soll abgestimmt werden?", en: "What should viewers vote on?" },
  options: { de: "Antworten", en: "Options" },
  optionNumber: { de: (number: number) => `Antwort ${String(number)}`, en: (number: number) => `Option ${String(number)}` },
  optionPlaceholder: { de: (number: number) => `Antwort ${String(number)}`, en: (number: number) => `Option ${String(number)}` },
  addOption: { de: "Antwort hinzufügen", en: "Add option" },
  remove: { de: "Entfernen", en: "Remove" },
  removeOption: { de: (number: number) => `Antwort ${String(number)} entfernen`, en: (number: number) => `Remove option ${String(number)}` },
  duration: { de: "Dauer", en: "Duration" },
  oneMinute: { de: "1 Minute", en: "1 minute" },
  twoMinutes: { de: "2 Minuten", en: "2 minutes" },
  fiveMinutes: { de: "5 Minuten", en: "5 minutes" },
  preview: { de: "Vorschau im Chat", en: "Chat preview" },
  previewQuestion: { de: "Deine Frage", en: "Your question" },
  previewHint: { de: "Frage und Antworten", en: "Question and options" },
  bot: { de: "Bot", en: "Bot" },
  yes: { de: "Ja", en: "Yes" },
  no: { de: "Nein", en: "No" },
  characterCount: {
    de: (count: number, maxLength: number) => `${String(count)}/${String(maxLength)} Zeichen`,
    en: (count: number, maxLength: number) => `${String(count)}/${String(maxLength)} characters`,
  },
} as const satisfies ChatVotingActionContentTexts;
