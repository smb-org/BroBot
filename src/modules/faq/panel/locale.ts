import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { GamePickerMessages, TextAreaMessages } from "../../../dashboard/ui";

export interface FaqTexts {
  title: string;
  add: string;
  name: string;
  patterns: string;
  patternsHint: string;
  answer: string;
  cooldown: string;
  cooldownHint: string;
  cooldownMinError: string;
  games: string;
  gamesHint: string;
  chatTarget: string;
  enabled: string;
  disabled: string;
  create: string;
  edit: string;
  save: string;
  cancel: string;
  delete: string;
  deleteConfirm: string;
  moveUp: string;
  moveDown: string;
  testHeading: string;
  testMessage: string;
  testButton: string;
  testNoMatch: string;
  testCommand: string;
  testMatch: (entry: string, pattern: string) => string;
  enabledState: string;
  noEntries: string;
  noBlocks: string;
  loadError: string;
  saveError: string;
  deleteError: string;
  missingBlock: string;
  inputDependentBlock: string;
  entryLimit: string;
  roleLocked: string;
  termCount: (count: number, max: number) => string;
  testEmpty: string;
  textAreaMessages: TextAreaMessages;
  gamePickerMessages: GamePickerMessages;
}

const countTextAreaMessages: TextAreaMessages = {
  countLabel: (count, max) => `${String(count)}/${String(max)}`,
  previewCountLabel: (count) => count,
  unknownVariable: (name, suggestion) => suggestion === null ? `Unknown template variable: ${name}` : `Unknown template variable: ${name}. Did you mean ${suggestion}?`,
  insertSuggestionLabel: (name) => `Insert ${name}`,
  worstCaseLength: (length, maximum) => `${String(length)} characters, maximum ${String(maximum)}.`,
};

const catalog: LocaleCatalog<FaqTexts> = {
  de: {
    title: "FAQ & Auto-Antworten", add: "FAQ-Eintrag anlegen", name: "Name", patterns: "Schlüsselwörter und Wortgruppen",
    patternsHint: "Ein Eintrag pro Zeile. Groß-/Kleinschreibung und Akzente werden ignoriert; Wörter müssen vollständig übereinstimmen.",
    answer: "Antwort-Textbaustein", cooldown: "Abkühlzeit", cooldownHint: "Mindestens 30 Sekunden; höchstens 86.400 Sekunden.",
    cooldownMinError: "Die Abkühlzeit muss mindestens 30 Sekunden betragen.",
    games: "Spiele", gamesHint: "Ohne Auswahl gilt der Eintrag für jedes Spiel.", chatTarget: "Chat-Ziel", enabled: "Aktiviert", disabled: "Deaktiviert",
    create: "Eintrag anlegen", edit: "Eintrag bearbeiten", save: "Speichern", cancel: "Abbrechen", delete: "Entfernen",
    deleteConfirm: "Diesen FAQ-Eintrag wirklich entfernen?", moveUp: "In der Reihenfolge nach oben", moveDown: "In der Reihenfolge nach unten",
    testHeading: "Treffer testen", testMessage: "Chatnachricht", testButton: "Nachricht prüfen", testNoMatch: "Kein aktivierter Eintrag passt.",
    testCommand: "Nachrichten mit Befehlspräfix werden übersprungen.", testMatch: (entry, pattern) => `Treffer: ${entry} · passt wegen „${pattern}“.`,
    enabledState: "FAQ aktivieren", noEntries: "Noch keine FAQ-Einträge.", noBlocks: "Lege zuerst einen Textbaustein in der Textbibliothek an.",
    loadError: "FAQ-Einträge konnten nicht geladen werden.", saveError: "Der FAQ-Eintrag konnte nicht gespeichert werden.",
    deleteError: "Der FAQ-Eintrag konnte nicht entfernt werden.", missingBlock: "Der ausgewählte Textbaustein existiert nicht mehr.",
    inputDependentBlock: "Dieser Textbaustein benötigt Eingaben aus einem Chatbefehl und kann nicht automatisch verwendet werden.",
    entryLimit: "Ein Kanal kann höchstens 100 FAQ-Einträge haben.", roleLocked: "Nur Broadcaster und Verwalter dürfen FAQ-Einträge bearbeiten.",
    termCount: (count, max) => `${String(count)}/${String(max)} Wortgruppen`, testEmpty: "Gib eine Nachricht ein, um den Treffer zu prüfen.", textAreaMessages: countTextAreaMessages,
    gamePickerMessages: {
      label: "Spiele", hint: "Ohne Auswahl gilt der Eintrag für jedes Spiel.", search: "Spiele suchen",
      searchHint: "Mindestens 2 Zeichen eingeben", loading: "Spiele werden geladen …", empty: "Keine Spiele gefunden.",
      error: "Spiele konnten nicht geladen werden.", remove: (name) => `${name} entfernen`,
    },
  },
  en: {
    title: "FAQ & Auto replies", add: "Create FAQ entry", name: "Name", patterns: "Keywords and phrases",
    patternsHint: "One per line. Case and accents are ignored; words must match in full.", answer: "Answer text block", cooldown: "Cooldown",
    cooldownHint: "At least 30 seconds; up to 86,400 seconds.", cooldownMinError: "Cooldown must be at least 30 seconds.",
    games: "Games", gamesHint: "Leave empty to use this entry for every game.",
    chatTarget: "Chat target", enabled: "Enabled", disabled: "Disabled", create: "Create entry", edit: "Edit entry", save: "Save",
    cancel: "Cancel", delete: "Delete", deleteConfirm: "Remove this FAQ entry?", moveUp: "Move earlier in the order", moveDown: "Move later in the order",
    testHeading: "Test a match", testMessage: "Chat message", testButton: "Check message", testNoMatch: "No enabled entry matches.",
    testCommand: "Messages with the command prefix are skipped.", testMatch: (entry, pattern) => `Match: ${entry} · matched because of “${pattern}”.`,
    enabledState: "Enable FAQ entry", noEntries: "No FAQ entries yet.", noBlocks: "Create a text block in the text library first.",
    loadError: "FAQ entries could not be loaded.", saveError: "The FAQ entry could not be saved.", deleteError: "The FAQ entry could not be deleted.",
    missingBlock: "The selected text block no longer exists.",
    inputDependentBlock: "This text block needs input from a chat command and cannot be used automatically.",
    entryLimit: "A channel can have up to 100 FAQ entries.", roleLocked: "Only broadcasters and managers can edit FAQ entries.",
    termCount: (count, max) => `${String(count)}/${String(max)} phrases`, testEmpty: "Enter a message to check for a match.", textAreaMessages: countTextAreaMessages,
    gamePickerMessages: {
      label: "Games", hint: "Leave empty to use this entry for every game.", search: "Search games",
      searchHint: "Enter at least 2 characters", loading: "Loading games…", empty: "No games found.",
      error: "Games could not be loaded.", remove: (name) => `Remove ${name}`,
    },
  },
};

export const faqTexts = (language?: DashboardLanguage): FaqTexts => catalog[language ?? "de"];
