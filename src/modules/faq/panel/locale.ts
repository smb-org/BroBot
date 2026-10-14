import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { ChipsInputMessages, GameMultiSelectMessages, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { FaqMinimumTier } from "../contracts";
import type { FaqMatcherValidationReasonCode } from "../domain";

export interface FaqTexts {
  title: string;
  add: string;
  newEntry: string;
  noSelection: string;
  noEntries: string;
  emptySearch: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  filterAll: string;
  filterActive: string;
  filterPaused: string;
  filterLabel: string;
  priorityNote: string;
  keyboardMove: string;
  priorityMeta: (priority: number) => string;
  prioritySaved: string;
  undo: string;
  unsavedNew: string;
  guardTitle: string;
  guardDescription: string;
  continueEditing: string;
  orderError: string;
  entryNameLabel: string;
  entryNameHint: string;
  triggerSection: string;
  matcherType: string;
  keywordsType: string;
  keywordsCompact: string;
  regexType: string;
  regexCompact: string;
  patterns: string;
  patternsPlaceholder: string;
  patternsHint: string;
  regexPattern: string;
  regexPatternHint: string;
  matcherValidationReasons: Record<FaqMatcherValidationReasonCode, string>;
  keywordChipMessages: ChipsInputMessages;
  removePattern: (pattern: string) => string;
  sampleMessage: string;
  testSample: string;
  sampleMessageHint: string;
  sampleMessageInvalid: string;
  sampleMessageEmpty: string;
  sampleMessageCommand: string;
  sampleMessageNoMatch: string;
  sampleMessageMatch: (pattern: string) => string;
  minimumTier: string;
  rolesSectionTitle: string;
  tierOptions: readonly { value: FaqMinimumTier; label: string; inclusion: string }[];
  rolesHint: string;
  previewLabel: string;
  previewSpeaker: string;
  gameFilterHint: string;
  answerSection: string;
  answer: string;
  answerHint: string;
  cooldown: string;
  cooldownHint: string;
  cooldownMinError: string;
  userCooldown: string;
  userCooldownHint: string;
  games: string;
  chatTarget: string;
  save: string;
  cancel: string;
  discard: string;
  saved: string;
  saving: string;
  invalid: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteConfirm: (name: string) => string;
  loadError: string;
  saveError: string;
  deleteError: string;
  missingTextBlock: string;
  inputDependentText: string;
  entryLimit: string;
  roleLocked: string;
  templateMessages: TemplateTextFieldMessages;
  gameMultiSelectMessages: GameMultiSelectMessages;
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
    title: "FAQ & Auto-Antworten", add: "Neu", newEntry: "Neue Antwort", noSelection: "Wähle eine Antwort aus oder erstelle eine neue.",
    noEntries: "Noch keine FAQ-Antworten.", emptySearch: "Keine Antwort passt zu deiner Suche.", search: "Antwort oder Auslöser suchen", searchPlaceholder: "FAQ durchsuchen", clearSearch: "Suche leeren",
    filterAll: "Alle", filterActive: "Aktiv", filterPaused: "Pausiert", filterLabel: "Status", priorityNote: "Die erste passende Antwort gewinnt. Ziehe Einträge an eine neue Stelle; Alt+↑/↓ verschiebt die Auswahl sofort.",
    keyboardMove: "Position sofort ändern", priorityMeta: (priority) => `Priorität ${String(priority)}`, prioritySaved: "Priorität gespeichert.", undo: "Rückgängig",
    unsavedNew: "Neue Antwort · nicht gespeichert", guardTitle: "Ungespeicherte Änderungen", guardDescription: "Speichere oder verwerfe deine Änderungen, bevor du wechselst.", continueEditing: "Weiter bearbeiten",
    orderError: "Die Priorität konnte nicht gespeichert werden. Lade die Seite neu und versuche es noch einmal.",
    entryNameLabel: "Name der Antwort", entryNameHint: "Wird nur in dieser Liste angezeigt.", triggerSection: "Auslöser", matcherType: "Auslösertyp", keywordsType: "Schlüsselwörter und Wortgruppen", keywordsCompact: "Wörter", regexType: "Regulärer Ausdruck (RE2)", regexCompact: "RE2", patterns: "Schlüsselwörter und Wortgruppen", patternsPlaceholder: "Begriff",
    patternsHint: "Begriffe mit Enter oder Komma hinzufügen. Groß-/Kleinschreibung und Akzente werden ignoriert; Wörter müssen vollständig übereinstimmen.",
    regexPattern: "RE2-Ausdruck", regexPatternHint: "RE2-Syntax; Groß-/Kleinschreibung wird beachtet. Lookaround und Rückverweise werden nicht unterstützt.",
    matcherValidationReasons: {
      faq_matcher_required: "Gib einen FAQ-Auslöser ein.",
      faq_regex_required: "Gib einen regulären Ausdruck ein.",
      faq_regex_too_long: "Der reguläre Ausdruck ist zu lang.",
      faq_regex_invalid: "Der RE2-Ausdruck ist ungültig oder verwendet nicht unterstützte Syntax.",
      faq_keywords_invalid: "Gib 1 bis 20 gültige Schlüsselwörter oder Wortgruppen ein.",
    },
    keywordChipMessages: { countLabel: (count, maximum) => `${String(count)}/${String(maximum)}`, atLimitHint: "Maximal 20 Auslöser. Entferne einen zum Austauschen.", duplicateWarning: (entry) => `„${entry}“ ist bereits hinzugefügt.` },
    removePattern: (pattern) => `${pattern} entfernen`, sampleMessage: "Beispielnachricht testen", testSample: "Beispiel testen", sampleMessageHint: "Die Prüfung verwendet genau diesen Eintrag und läuft beim Tippen.", sampleMessageInvalid: "Korrigiere den Auslöser, um ihn zu testen.",
    sampleMessageEmpty: "Gib eine Nachricht ein, um den Auslöser zu testen.", sampleMessageCommand: "Nachrichten mit ! am Anfang werden übersprungen.", sampleMessageNoMatch: "Kein Auslöser passt zu dieser Nachricht.",
    sampleMessageMatch: (pattern) => `Treffer durch „${pattern}“.`,
    minimumTier: "Mindestrolle", rolesSectionTitle: "Wer darf auslösen", tierOptions: [
      { value: "everyone", label: "Alle", inclusion: "Alle Zuschauer und Rollen dürfen auslösen." },
      { value: "subscriber", label: "Abonnenten", inclusion: "Abonnenten, Moderatoren und Broadcaster dürfen auslösen. VIPs nicht." },
      { value: "vip", label: "VIPs", inclusion: "VIPs, Moderatoren und Broadcaster dürfen auslösen." },
      { value: "moderator", label: "Moderatoren", inclusion: "Moderatoren und Broadcaster dürfen auslösen." },
      { value: "broadcaster", label: "Broadcaster", inclusion: "Nur der Broadcaster darf auslösen." },
    ], rolesHint: "Die Schwelle prüft den Twitch-Status der Person, die die Nachricht sendet.",
    previewLabel: "Vorschau", previewSpeaker: "Bot", gameFilterHint: "Ohne Auswahl gilt die Antwort für jedes Spiel.", answerSection: "Antwortvorlage",
    answer: "Antwort", answerHint: "Freitext mit Variablen und Textbausteinen im Format {text.name}.", cooldown: "Abkühlzeit für alle", cooldownHint: "Mindestens 30 Sekunden; höchstens 86.400 Sekunden.",
    cooldownMinError: "Die Abkühlzeit muss mindestens 30 Sekunden betragen.",
    userCooldown: "Abkühlzeit pro Person", userCooldownHint: "0 deaktiviert diese zusätzliche Abkühlzeit. Höchstens 86.400 Sekunden.",
    games: "Spiele", chatTarget: "Chat-Ziel",
    save: "Speichern", cancel: "Abbrechen", discard: "Verwerfen", saved: "Gespeichert", saving: "Speichert …", invalid: "Prüfe die markierten Felder.", delete: "Antwort löschen",
    deleteTitle: (name) => `„${name}“ löschen?`, deleteConfirm: (name) => `Die Antwort „${name}“ wird aus der Prioritätenliste entfernt.`,
    loadError: "FAQ-Einträge konnten nicht geladen werden.", saveError: "Der FAQ-Eintrag konnte nicht gespeichert werden.",
    deleteError: "Der FAQ-Eintrag konnte nicht entfernt werden.", missingTextBlock: "Ein verwendeter Textbaustein existiert nicht mehr.",
    inputDependentText: "FAQ-Antworten können keine Eingaben aus einem Chatbefehl verwenden.",
    entryLimit: "Ein Kanal kann höchstens 100 FAQ-Antworten haben.", roleLocked: "Nur Broadcaster und Verwalter dürfen FAQ-Antworten bearbeiten.",
    templateMessages: templateMessages.de,
    gameMultiSelectMessages: {
      label: "Spiele", hint: "Ohne Auswahl gilt der Eintrag für jedes Spiel.", search: "Spiele suchen",
      searchHint: "Mindestens 2 Zeichen eingeben", loading: "Spiele werden geladen …", empty: "Keine Spiele gefunden.",
      error: "Spiele konnten nicht geladen werden.", suggestions: "Vorschläge", allGames: "Alle Spiele",
      limitReached: "10er-Limit erreicht; entferne eins zum Austauschen.",
      selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)}`, remove: (name) => `${name} entfernen`,
    },
  },
  en: {
    title: "FAQ & Auto replies", add: "New", newEntry: "New answer", noSelection: "Choose an answer or create a new one.",
    noEntries: "No FAQ answers yet.", emptySearch: "No answer matches your search.", search: "Search answers or triggers", searchPlaceholder: "Search FAQ", clearSearch: "Clear search",
    filterAll: "All", filterActive: "Active", filterPaused: "Paused", filterLabel: "Status", priorityNote: "The first matching answer wins. Drag entries to reorder them; Alt+↑/↓ moves the selection immediately.",
    keyboardMove: "Change position immediately", priorityMeta: (priority) => `Priority ${String(priority)}`, prioritySaved: "Priority saved.", undo: "Undo",
    unsavedNew: "New answer · not saved", guardTitle: "Unsaved changes", guardDescription: "Save or discard your changes before switching.", continueEditing: "Continue editing",
    orderError: "Priority could not be saved. Reload the page and try again.",
    entryNameLabel: "Answer name", entryNameHint: "Only shown in this list.", triggerSection: "Trigger", matcherType: "Trigger type", keywordsType: "Keywords and phrases", keywordsCompact: "Words", regexType: "Regular expression (RE2)", regexCompact: "RE2", patterns: "Keywords and phrases", patternsPlaceholder: "Keyword",
    patternsHint: "Add phrases with Enter or a comma. Matching ignores case and accents; words must match in full.", answer: "Answer", answerHint: "Free text with variables and text blocks in the {text.name} format.", cooldown: "Global cooldown",
    regexPattern: "RE2 pattern", regexPatternHint: "RE2 syntax; matching is case-sensitive. Lookaround and backreferences are not supported.",
    matcherValidationReasons: {
      faq_matcher_required: "Enter an FAQ trigger.",
      faq_regex_required: "Enter a regular expression.",
      faq_regex_too_long: "The regular expression is too long.",
      faq_regex_invalid: "The RE2 pattern is invalid or uses unsupported syntax.",
      faq_keywords_invalid: "Enter 1 to 20 valid keywords or phrases.",
    },
    keywordChipMessages: { countLabel: (count, maximum) => `${String(count)}/${String(maximum)}`, atLimitHint: "Up to 20 triggers. Remove one to replace it.", duplicateWarning: (entry) => `“${entry}” has already been added.` },
    removePattern: (pattern) => `Remove ${pattern}`, sampleMessage: "Test a sample message", testSample: "Test sample", sampleMessageHint: "This checks only this entry and updates as you type.", sampleMessageInvalid: "Fix the trigger before testing it.",
    sampleMessageEmpty: "Enter a message to test the trigger.", sampleMessageCommand: "Messages starting with ! are skipped.", sampleMessageNoMatch: "No trigger matches this message.",
    sampleMessageMatch: (pattern) => `Matched by “${pattern}”.`,
    minimumTier: "Minimum role", rolesSectionTitle: "Who can trigger it", tierOptions: [
      { value: "everyone", label: "Everyone", inclusion: "Every viewer and role can trigger it." },
      { value: "subscriber", label: "Subscribers", inclusion: "Subscribers, moderators, and broadcasters can trigger it. VIPs cannot." },
      { value: "vip", label: "VIPs", inclusion: "VIPs, moderators, and broadcasters can trigger it." },
      { value: "moderator", label: "Moderators", inclusion: "Moderators and broadcasters can trigger it." },
      { value: "broadcaster", label: "Broadcaster", inclusion: "Only the broadcaster can trigger it." },
    ], rolesHint: "The threshold checks the Twitch status of the person who sent the message.",
    previewLabel: "Preview", previewSpeaker: "Bot", gameFilterHint: "Leave empty to use this answer for every game.", answerSection: "Answer template",
    cooldownHint: "At least 30 seconds; up to 86,400 seconds.", cooldownMinError: "Cooldown must be at least 30 seconds.",
    userCooldown: "Per-person cooldown", userCooldownHint: "0 disables this additional cooldown. Up to 86,400 seconds.",
    games: "Games",
    chatTarget: "Chat target", save: "Save", cancel: "Cancel", discard: "Discard", saved: "Saved", saving: "Saving …", invalid: "Check the highlighted fields.", delete: "Delete answer",
    deleteTitle: (name) => `Delete “${name}”?`, deleteConfirm: (name) => `The answer “${name}” will be removed from the priority list.`,
    loadError: "FAQ entries could not be loaded.", saveError: "The FAQ entry could not be saved.", deleteError: "The FAQ entry could not be deleted.",
    missingTextBlock: "A referenced text block no longer exists.",
    inputDependentText: "FAQ answers cannot use input from a chat command.",
    entryLimit: "A channel can have up to 100 FAQ answers.", roleLocked: "Only broadcasters and managers can edit FAQ answers.",
    templateMessages: templateMessages.en,
    gameMultiSelectMessages: {
      label: "Games", hint: "Leave empty to use this entry for every game.", search: "Search games",
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
