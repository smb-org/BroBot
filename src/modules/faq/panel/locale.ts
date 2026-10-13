import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { GameMultiSelectMessages, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { FaqMatcherValidationReasonCode } from "../domain";

export interface FaqTexts {
  title: string;
  add: string;
  name: string;
  matcherType: string;
  keywordsType: string;
  regexType: string;
  patterns: string;
  patternsHint: string;
  regexPattern: string;
  regexPatternHint: string;
  matcherValidationReasons: Record<FaqMatcherValidationReasonCode, string>;
  answer: string;
  answerHint: string;
  cooldown: string;
  cooldownHint: string;
  cooldownMinError: string;
  userCooldown: string;
  userCooldownHint: string;
  games: string;
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
  testSkippedByGame: (entry: string, games: string) => string;
  noEntries: string;
  loadError: string;
  saveError: string;
  deleteError: string;
  missingTextBlock: string;
  inputDependentText: string;
  entryLimit: string;
  roleLocked: string;
  testEmpty: string;
  templateMessages: TemplateTextFieldMessages;
  gameMultiSelectMessages: GameMultiSelectMessages;
  testGameMultiSelectMessages: GameMultiSelectMessages;
}

const templateMessages: LocaleCatalog<TemplateTextFieldMessages> = {
  de: {
    countLabel: (count, max) => `${String(count)}/${String(max)}`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `${String(length)} Zeichen, höchstens ${String(maximum)}.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage ausgeführt wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, max) => `${String(count)}/${String(max)}`,
    previewCountLabel: (count) => `${String(count)} characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `${String(length)} characters, maximum ${String(maximum)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

const catalog: LocaleCatalog<FaqTexts> = {
  de: {
    title: "FAQ & Auto-Antworten", add: "FAQ-Eintrag anlegen", name: "Name", matcherType: "Auslösertyp", keywordsType: "Schlüsselwörter und Wortgruppen", regexType: "Regulärer Ausdruck (RE2)", patterns: "Schlüsselwörter und Wortgruppen",
    patternsHint: "Ein Eintrag pro Zeile. Groß-/Kleinschreibung und Akzente werden ignoriert; Wörter müssen vollständig übereinstimmen.",
    regexPattern: "RE2-Ausdruck", regexPatternHint: "RE2-Syntax; Groß-/Kleinschreibung wird beachtet. Lookaround und Rückverweise werden nicht unterstützt.",
    matcherValidationReasons: {
      faq_matcher_required: "Gib einen FAQ-Auslöser ein.",
      faq_regex_required: "Gib einen regulären Ausdruck ein.",
      faq_regex_too_long: "Der reguläre Ausdruck ist zu lang.",
      faq_regex_invalid: "Der RE2-Ausdruck ist ungültig oder verwendet nicht unterstützte Syntax.",
      faq_keywords_invalid: "Gib 1 bis 20 gültige Schlüsselwörter oder Wortgruppen ein.",
    },
    answer: "Antwort", answerHint: "Freitext mit Variablen und Textbausteinen im Format {text.name}.", cooldown: "Abkühlzeit", cooldownHint: "Mindestens 30 Sekunden; höchstens 86.400 Sekunden.",
    cooldownMinError: "Die Abkühlzeit muss mindestens 30 Sekunden betragen.",
    userCooldown: "Abkühlzeit pro Person", userCooldownHint: "0 deaktiviert diese zusätzliche Abkühlzeit. Höchstens 86.400 Sekunden.",
    games: "Spiele", chatTarget: "Chat-Ziel", enabled: "Aktiviert", disabled: "Deaktiviert",
    create: "Eintrag anlegen", edit: "Eintrag bearbeiten", save: "Speichern", cancel: "Abbrechen", delete: "Entfernen",
    deleteConfirm: "Diesen FAQ-Eintrag wirklich entfernen?", moveUp: "In der Reihenfolge nach oben", moveDown: "In der Reihenfolge nach unten",
    testHeading: "Treffer testen", testMessage: "Chatnachricht", testButton: "Nachricht prüfen", testNoMatch: "Kein aktivierter Eintrag passt.",
    testCommand: "Nachrichten mit Befehlspräfix werden übersprungen.", testMatch: (entry, pattern) => `Treffer: ${entry} · passt wegen „${pattern}“.`,
    testSkippedByGame: (entry, games) => `${entry} passt ebenfalls, ist aber auf ${games} beschränkt und wird beim simulierten Spiel übersprungen.`,
    noEntries: "Noch keine FAQ-Einträge.",
    loadError: "FAQ-Einträge konnten nicht geladen werden.", saveError: "Der FAQ-Eintrag konnte nicht gespeichert werden.",
    deleteError: "Der FAQ-Eintrag konnte nicht entfernt werden.", missingTextBlock: "Ein verwendeter Textbaustein existiert nicht mehr.",
    inputDependentText: "FAQ-Antworten können keine Eingaben aus einem Chatbefehl verwenden.",
    entryLimit: "Ein Kanal kann höchstens 100 FAQ-Einträge haben.", roleLocked: "Nur Broadcaster und Verwalter dürfen FAQ-Einträge bearbeiten.",
    testEmpty: "Gib eine Nachricht ein, um den Treffer zu prüfen.", templateMessages: templateMessages.de,
    gameMultiSelectMessages: {
      label: "Spiele", hint: "Ohne Auswahl gilt der Eintrag für jedes Spiel.", search: "Spiele suchen",
      searchHint: "Mindestens 2 Zeichen eingeben", loading: "Spiele werden geladen …", empty: "Keine Spiele gefunden.",
      error: "Spiele konnten nicht geladen werden.", suggestions: "Vorschläge", allGames: "Alle Spiele",
      limitReached: "10er-Limit erreicht; entferne eins zum Austauschen.",
      selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)}`, remove: (name) => `${name} entfernen`,
    },
    testGameMultiSelectMessages: {
      label: "Spiel simulieren", hint: "Ohne Auswahl wird das aktuelle Spiel des Kanals verwendet.", search: "Spiele suchen",
      searchHint: "Mindestens 2 Zeichen eingeben", loading: "Spiele werden geladen …", empty: "Keine Spiele gefunden.",
      error: "Spiele konnten nicht geladen werden.", suggestions: "Vorschläge", allGames: "Alle Spiele",
      limitReached: "10er-Limit erreicht; entferne eins zum Austauschen.",
      selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)}`, remove: (name) => `${name} entfernen`,
    },
  },
  en: {
    title: "FAQ & Auto replies", add: "Create FAQ entry", name: "Name", matcherType: "Trigger type", keywordsType: "Keywords and phrases", regexType: "Regular expression (RE2)", patterns: "Keywords and phrases",
    patternsHint: "One per line. Case and accents are ignored; words must match in full.", answer: "Answer", answerHint: "Free text with variables and text blocks in the {text.name} format.", cooldown: "Cooldown",
    regexPattern: "RE2 pattern", regexPatternHint: "RE2 syntax; matching is case-sensitive. Lookaround and backreferences are not supported.",
    matcherValidationReasons: {
      faq_matcher_required: "Enter an FAQ trigger.",
      faq_regex_required: "Enter a regular expression.",
      faq_regex_too_long: "The regular expression is too long.",
      faq_regex_invalid: "The RE2 pattern is invalid or uses unsupported syntax.",
      faq_keywords_invalid: "Enter 1 to 20 valid keywords or phrases.",
    },
    cooldownHint: "At least 30 seconds; up to 86,400 seconds.", cooldownMinError: "Cooldown must be at least 30 seconds.",
    userCooldown: "Per-person cooldown", userCooldownHint: "0 disables this additional cooldown. Up to 86,400 seconds.",
    games: "Games",
    chatTarget: "Chat target", enabled: "Enabled", disabled: "Disabled", create: "Create entry", edit: "Edit entry", save: "Save",
    cancel: "Cancel", delete: "Delete", deleteConfirm: "Remove this FAQ entry?", moveUp: "Move earlier in the order", moveDown: "Move later in the order",
    testHeading: "Test a match", testMessage: "Chat message", testButton: "Check message", testNoMatch: "No enabled entry matches.",
    testCommand: "Messages with the command prefix are skipped.", testMatch: (entry, pattern) => `Match: ${entry} · matched because of “${pattern}”.`,
    testSkippedByGame: (entry, games) => `${entry} also matches, but is restricted to ${games} and was skipped for the simulated game.`,
    noEntries: "No FAQ entries yet.",
    loadError: "FAQ entries could not be loaded.", saveError: "The FAQ entry could not be saved.", deleteError: "The FAQ entry could not be deleted.",
    missingTextBlock: "A referenced text block no longer exists.",
    inputDependentText: "FAQ answers cannot use input from a chat command.",
    entryLimit: "A channel can have up to 100 FAQ entries.", roleLocked: "Only broadcasters and managers can edit FAQ entries.",
    testEmpty: "Enter a message to check for a match.", templateMessages: templateMessages.en,
    gameMultiSelectMessages: {
      label: "Games", hint: "Leave empty to use this entry for every game.", search: "Search games",
      searchHint: "Enter at least 2 characters", loading: "Loading games…", empty: "No games found.",
      error: "Games could not be loaded.", suggestions: "Suggestions", allGames: "All games",
      limitReached: "10-game limit reached; remove one to add another.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`, remove: (name) => `Remove ${name}`,
    },
    testGameMultiSelectMessages: {
      label: "Simulate game", hint: "Leave empty to use the channel's current game.", search: "Search games",
      searchHint: "Enter at least 2 characters", loading: "Loading games…", empty: "No games found.",
      error: "Games could not be loaded.", suggestions: "Suggestions", allGames: "All games",
      limitReached: "10-game limit reached; remove one to add another.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`, remove: (name) => `Remove ${name}`,
    },
  },
};

export const faqMatcherValidationReasonText = (reasonCode: string, texts: FaqTexts): string | undefined =>
  Object.hasOwn(texts.matcherValidationReasons, reasonCode)
    ? texts.matcherValidationReasons[reasonCode as FaqMatcherValidationReasonCode]
    : undefined;

export const faqTexts = (language?: DashboardLanguage): FaqTexts => catalog[language ?? "de"];
