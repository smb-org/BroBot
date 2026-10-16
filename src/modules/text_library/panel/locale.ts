import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";
import type { TextBlockUsage } from "../contracts";
import type { GameMultiSelectMessages, TemplateTextFieldPickerMessages } from "../../../dashboard/ui";

export interface TextLibraryTexts {
  library: string;
  search: string;
  activeFilters: string;
  resetFilters: string;
  countSuffix: (count: number) => string;
  limitSuffix: (count: number) => string;
  filteredSuffix: (count: number) => string;
  categoryFilter: string;
  gameFilter: string;
  allCategories: string;
  addBlock: string;
  empty: string;
  loadError: string;
  save: string;
  create: string;
  draftGuardTitle: string;
  draftGuardDescription: string;
  continueEditing: string;
  discardAndSwitch: string;
  saveAndSwitch: string;
  close: string;
  delete: string;
  deleteTitle: (name: string) => string;
  deleteConsequence: (name: string) => string;
  deleteBlocked: string;
  deleteBlockedReason: (count: number) => string;
  deleteBlockedTitle: (name: string) => string;
  deleteOperatorReason: string;
  deleteConfirm: (name: string) => string;
  name: string;
  nameHint: string;
  nameInvalid: string;
  nameExists: string;
  nameReserved: string;
  generalSection: string;
  category: string;
  categories: string;
  categoryAdd: string;
  categoryName: string;
  categoryRename: string;
  categoryDelete: string;
  categoryEmpty: string;
  categoryLimit: string;
  categoryDeleteBlocked: string;
  blockLimitReached: (count: number, maximum: number) => string;
  managementLocked: string;
  gameBound: string;
  variants: string;
  addVariant: string;
  variant: (index: number) => string;
  defaultVariant: string;
  moveUp: string;
  moveDown: string;
  removeVariant: string;
  conditions: string;
  anyCondition: string;
  noConditions: string;
  stream: string;
  anyStream: string;
  online: string;
  offline: string;
  gameCondition: string;
  gameMatch: string;
  gameIs: string;
  gameIsNot: string;
  minimumTier: string;
  noMinimumTier: string;
  tierLabels: Record<string, string>;
  weekdays: string;
  timeWindow: string;
  addTimeWindow: string;
  removeTimeWindow: string;
  startTime: string;
  endTime: string;
  text: string;
  textHint: string;
  variableDescription: (name: string) => string;
  openBrace: string;
  unknownVariable: (name: string, suggestion: string | null) => string;
  picker: TemplateTextFieldPickerMessages;
  addText: string;
  insertSuggestionLabel: (name: string) => string;
  insertionLimit: string;
  removeText: string;
  preview: string;
  simulateStream: string;
  simulateContext: string;
  commandContext: string;
  eventContext: string;
  selectedVariant: (name: string) => string;
  noMatchingVariant: string;
  blockUnavailableForGame: string;
  previewTooLong: (blockNames: readonly string[]) => string;
  operatorReason: string;
  conflict: string;
  reload: string;
  cycle: (path: readonly string[]) => string;
  depth: (path: readonly string[]) => string;
  saveError: string;
  deleteMenuLabel: string;
  templateInputDependent: (consumerName: string) => string;
  uses: string;
  viewUsages: string;
  usesCount: (count: number) => string;
  noUsages: string;
  usageKind: Record<TextBlockUsage["kind"], string>;
  roleConditionHint: string;
  inputContextWarning: string;
  filterAny: string;
  variantsCount: (count: number) => string;
  gameMultiSelect: GameMultiSelectMessages;
  categoryLabels: Record<"social" | "info" | "faq" | "game" | "fun", string>;
  weekdaysLabels: readonly string[];
  errors: Record<string, string>;
}

const catalog: LocaleCatalog<TextLibraryTexts> = {
  de: {
    library: "Textbausteine",
    search: "Textbausteine suchen",
    activeFilters: "Aktive Filter:",
    resetFilters: "Zurücksetzen",
    countSuffix: (count) => count === 1 ? "Textbaustein" : "Textbausteine",
    limitSuffix: (count) => `${count === 1 ? "Textbaustein" : "Textbausteinen"} belegt`,
    filteredSuffix: (count) => count === 1 ? "Textbaustein" : "Textbausteine",
    categoryFilter: "Kategorie",
    allCategories: "Alle Kategorien",
    gameFilter: "Spiel",
    addBlock: "Textbaustein anlegen",
    empty: "Noch keine Textbausteine gefunden.",
    loadError: "Die Textbibliothek konnte nicht geladen werden.",
    save: "Änderungen speichern",
    create: "Anlegen",
    draftGuardTitle: "Ungespeicherte Änderungen",
    draftGuardDescription: "Dieser Textbaustein enthält ungespeicherte Änderungen. Was möchtest du tun?",
    continueEditing: "Weiter bearbeiten",
    discardAndSwitch: "Verwerfen und wechseln",
    saveAndSwitch: "Speichern und wechseln",
    close: "Schließen",
    delete: "Textbaustein löschen",
    deleteTitle: (name) => `Textbaustein „${name}“ löschen?`,
    deleteConsequence: (name) => `Textbaustein „${name}“ kann nur gelöscht werden, wenn er nicht verwendet wird.`,
    deleteBlocked: "Dieser Textbaustein wird verwendet und kann erst gelöscht werden, wenn alle Verwendungen entfernt sind.",
    deleteBlockedReason: (count) => `Wird an ${String(count)} ${count === 1 ? "Stelle" : "Stellen"} verwendet`,
    deleteBlockedTitle: (name) => `Verwendungen von „${name}“ verhindern das Löschen`,
    deleteOperatorReason: "Nur Broadcaster und Verwalter",
    deleteConfirm: (name) => `Textbaustein löschen: ${name}`,
    name: "Name",
    nameHint: "Kleinbuchstaben, Zahlen und Unterstrich; wird als {text.name} eingesetzt.",
    nameInvalid: "Nur a–z, 0–9 und Unterstriche; höchstens 32 Zeichen.",
    nameExists: "Dieser Name ist bereits vergeben.",
    nameReserved: "Dieser Name ist für eine Vorlagenvariable reserviert.",
    generalSection: "Allgemein",
    category: "Kategorie",
    categories: "Kategorien",
    categoryAdd: "Kategorie hinzufügen",
    categoryName: "Kategoriename",
    categoryRename: "Umbenennen",
    categoryDelete: "Löschen",
    categoryEmpty: "Kategorie ist leer.",
    categoryLimit: "Es können höchstens 25 Kategorien angelegt werden.",
    categoryDeleteBlocked: "Kategorie kann nur gelöscht werden, wenn sie leer ist.",
    blockLimitReached: (count, maximum) => `${String(count)} von ${String(maximum)} genutzt: Grenze erreicht.`,
    managementLocked: "Nur Broadcaster und Verwalter dürfen Textbausteine anlegen.",
    gameBound: "Nur für diese Spiele",
    variants: "Varianten",
    addVariant: "Variante hinzufügen",
    variant: (index) => `Variante ${String(index)}`,
    defaultVariant: "Standardvariante",
    moveUp: "Nach oben",
    moveDown: "Nach unten",
    removeVariant: "Variante entfernen",
    conditions: "Bedingungen – alle müssen zutreffen",
    anyCondition: "Beliebig",
    noConditions: "Keine; diese Variante greift als letzte Möglichkeit.",
    stream: "Streamstatus",
    anyStream: "Beliebig",
    online: "Live",
    offline: "Offline",
    gameCondition: "Aktuelles Spiel",
    gameMatch: "Spielbedingung",
    gameIs: "ist",
    gameIsNot: "ist nicht",
    minimumTier: "Aufrufer mindestens",
    noMinimumTier: "Keine Rollenbedingung",
    tierLabels: { everyone: "Alle", subscriber: "Abonnent", vip: "VIP", moderator: "Moderator", broadcaster: "Broadcaster" },
    weekdays: "Wochentage",
    timeWindow: "Zeitfenster in der Kanalzeitzone",
    addTimeWindow: "Zeitfenster hinzufügen",
    removeTimeWindow: "Zeitfenster entfernen",
    startTime: "Von",
    endTime: "Bis",
    text: "Text",
    textHint: "Vorlagenvariablen wie {user} und Textbausteine wie {text.welcome} werden beim Senden aufgelöst.",
    variableDescription: (name) => `Textbaustein {text.${name}}`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
    addText: "Zufallstext hinzufügen",
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    removeText: "Text entfernen",
    preview: "Vorschau",
    simulateStream: "Simulierter Streamstatus",
    simulateContext: "Vorschaukontext",
    commandContext: "Befehl",
    eventContext: "Ereignis, Overlay oder Timer",
    selectedVariant: (name) => `Angewandte Variante: ${name}`,
    noMatchingVariant: "Keine Variante trifft unter diesen Bedingungen zu.",
    blockUnavailableForGame: "Der Textbaustein ist für das simulierte Spiel nicht aktiv.",
    previewTooLong: (blockNames) => {
      const names = blockNames.map((name) => `{text.${name}}`).join(", ");
      const cause = blockNames.length === 1 ? `den eingebetteten Textbaustein ${names}` : `eingebettete Textbausteine ${names}`;
      return `Diese Variante kann durch ${cause} mehr als 500 Zeichen ergeben. Chat-Ausgaben werden bei 500 Zeichen gekürzt.`;
    },
    operatorReason: "Nur Broadcaster und Verwalter dürfen Textbausteine und Kategorien ändern.",
    conflict: "Dieser Textbaustein wurde inzwischen geändert. Lade den Serverstand neu.",
    reload: "Neu laden",
    cycle: (path) => `Zirkuläre Einbettung: ${path.join(" → ")}.`,
    depth: (path) => `Die Einbettung überschreitet die maximale Tiefe von 3: ${path.join(" → ")}.`,
    saveError: "Der Textbaustein konnte nicht gespeichert werden.",
    deleteMenuLabel: "Löschen",
    templateInputDependent: (consumerName) => `Diese Änderung würde „${consumerName}“ von Chatbefehl-Eingaben abhängig machen.`,
    uses: "Verwendet in",
    viewUsages: "Verwendungen anzeigen",
    usesCount: (count) => `${String(count)} ${count === 1 ? "Verwendung" : "Verwendungen"}`,
    noUsages: "Noch keine Verwendungen.",
    usageKind: { block: "Textbaustein", command: "Befehl", faq: "FAQ", timer: "Timer", overlay: "Overlay", event: "Ereignis" },
    roleConditionHint: "Rollenbedingungen greifen nur in Chatbefehlen; in Ereignissen, Overlays und Timern sind sie immer falsch.",
    inputContextWarning: "Diese Vorlage enthält Eingabevariablen aus einem Chatbefehl. Außerhalb von Befehlen erscheint deren Nutzungs- oder Fehlertext.",
    filterAny: "Alle Spiele",
    variantsCount: (count) => `${String(count)} ${count === 1 ? "Variante" : "Varianten"}`,
    gameMultiSelect: {
      label: "Twitch-Spiele",
      hint: "Spiele über Twitch-Kategorien suchen und auswählen.",
      search: "Spiel suchen",
      searchHint: "Mindestens zwei Zeichen eingeben.",
      loading: "Spiele werden gesucht …",
      empty: "Keine Spiele gefunden.",
      error: "Die Twitch-Spiele konnten nicht geladen werden.",
      suggestions: "Vorschläge",
      allGames: "Alle Spiele",
      limitReached: "10er-Limit erreicht; entferne eins zum Austauschen.",
      selectedCount: (count, maximum) => `${String(count)} von ${String(maximum)}`,
      remove: (name) => `${name} entfernen`,
    },
    categoryLabels: { social: "Soziales", info: "Info", faq: "FAQ", game: "Spiel", fun: "Spaß" },
    weekdaysLabels: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
    errors: {
      text_library_block_exists: "Dieser Name ist bereits vergeben.",
      text_library_block_reserved_name: "Dieser Name ist für eine Vorlagenvariable reserviert.",
      text_library_block_conflict: "Dieser Textbaustein wurde inzwischen geändert.",
      text_library_block_rename_too_long: "Der neue Name würde die maximale Textlänge an einer verwendeten Stelle überschreiten.",
      text_library_block_limit: "Der Kanal hat bereits 200 Textbausteine.",
      text_library_block_invalid: "Prüfe Name, Kategorien, Bedingungen und Texte des Textbausteins.",
      text_library_template_usage_invalid: "Diese Änderung ist mit mindestens einer verwendeten Vorlage nicht vereinbar.",
      text_library_reference_cycle: "Zirkuläre Einbettung erkannt.",
      text_library_reference_depth_exceeded: "Die Einbettung überschreitet die maximale Tiefe von 3.",
      text_library_category_not_found: "Diese Kategorie gibt es nicht mehr.",
      text_library_category_not_empty: "Kategorie kann nur gelöscht werden, wenn sie leer ist.",
      text_library_management_denied: "Nur Broadcaster und Verwalter dürfen Änderungen speichern.",
      text_library_category_limit: "Es können höchstens 25 Kategorien angelegt werden.",
    },
  },
  en: {
    library: "Text blocks",
    search: "Search text blocks",
    activeFilters: "Active filters:",
    resetFilters: "Reset",
    countSuffix: (count) => count === 1 ? "text block" : "text blocks",
    limitSuffix: (count) => `${count === 1 ? "text block" : "text blocks"} used`,
    filteredSuffix: (count) => count === 1 ? "text block" : "text blocks",
    categoryFilter: "Category",
    allCategories: "All categories",
    gameFilter: "Game",
    addBlock: "Add text block",
    empty: "No text blocks found.",
    loadError: "The text library could not be loaded.",
    save: "Save changes",
    create: "Create",
    draftGuardTitle: "Unsaved changes",
    draftGuardDescription: "This text block has unsaved changes. What would you like to do?",
    continueEditing: "Continue editing",
    discardAndSwitch: "Discard and switch",
    saveAndSwitch: "Save and switch",
    close: "Close",
    delete: "Delete text block",
    deleteTitle: (name) => `Delete text block “${name}”?`,
    deleteConsequence: (name) => `Text block “${name}” can only be deleted when it is unused.`,
    deleteBlocked: "This text block is in use. Remove all listed uses before deleting it.",
    deleteBlockedReason: (count) => `Used in ${String(count)} ${count === 1 ? "place" : "places"}`,
    deleteBlockedTitle: (name) => `Uses of “${name}” prevent deletion`,
    deleteOperatorReason: "Broadcasters and managers only",
    deleteConfirm: (name) => `Delete text block: ${name}`,
    name: "Name",
    nameHint: "Lowercase letters, numbers, and underscores; insert it as {text.name}.",
    nameInvalid: "Use only a–z, 0–9, and underscores; up to 32 characters.",
    nameExists: "This name is already in use.",
    nameReserved: "This name is reserved for a template variable.",
    generalSection: "General",
    category: "Category",
    categories: "Categories",
    categoryAdd: "Add category",
    categoryName: "Category name",
    categoryRename: "Rename",
    categoryDelete: "Delete",
    categoryEmpty: "Category is empty.",
    categoryLimit: "A channel can have up to 25 categories.",
    categoryDeleteBlocked: "A category can only be deleted when it is empty.",
    blockLimitReached: (count, maximum) => `${String(count)} of ${String(maximum)} used: limit reached.`,
    managementLocked: "Only broadcasters and managers may add text blocks.",
    gameBound: "Only for these games",
    variants: "Variants",
    addVariant: "Add variant",
    variant: (index) => `Variant ${String(index)}`,
    defaultVariant: "Default variant",
    moveUp: "Move up",
    moveDown: "Move down",
    removeVariant: "Remove variant",
    conditions: "Conditions — all must match",
    anyCondition: "Any",
    noConditions: "None; this variant is the final fallback.",
    stream: "Stream status",
    anyStream: "Any",
    online: "Live",
    offline: "Offline",
    gameCondition: "Current game",
    gameMatch: "Game match",
    gameIs: "is",
    gameIsNot: "is not",
    minimumTier: "Caller role at least",
    noMinimumTier: "No role condition",
    tierLabels: { everyone: "Everyone", subscriber: "Subscriber", vip: "VIP", moderator: "Moderator", broadcaster: "Broadcaster" },
    weekdays: "Weekdays",
    timeWindow: "Time window in channel time zone",
    addTimeWindow: "Add time window",
    removeTimeWindow: "Remove time window",
    startTime: "From",
    endTime: "To",
    text: "Text",
    textHint: "Template variables like {user} and text blocks like {text.welcome} are resolved when sent.",
    variableDescription: (name) => `Text block {text.${name}}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
    addText: "Add random text",
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    removeText: "Remove text",
    preview: "Preview",
    simulateStream: "Simulated stream status",
    simulateContext: "Preview context",
    commandContext: "Command",
    eventContext: "Event, overlay, or timer",
    selectedVariant: (name) => `Matching variant: ${name}`,
    noMatchingVariant: "No variant matches this state.",
    blockUnavailableForGame: "This text block is not active for the simulated game.",
    previewTooLong: (blockNames) => {
      const names = blockNames.map((name) => `{text.${name}}`).join(", ");
      const cause = blockNames.length === 1 ? `text block ${names}` : `text blocks ${names}`;
      return `This variant can exceed 500 characters because it embeds ${cause}. Chat output is truncated at 500 characters.`;
    },
    operatorReason: "Only broadcasters and managers can change text blocks and categories.",
    conflict: "This text block has changed since you opened it. Reload the server version.",
    reload: "Reload",
    cycle: (path) => `Circular reference: ${path.join(" → ")}.`,
    depth: (path) => `Nesting exceeds the maximum depth of 3: ${path.join(" → ")}.`,
    saveError: "The text block could not be saved.",
    deleteMenuLabel: "Delete",
    templateInputDependent: (consumerName) => `This change would make “${consumerName}” depend on chat command input.`,
    uses: "Used in",
    viewUsages: "Show usage",
    usesCount: (count) => `${String(count)} ${count === 1 ? "use" : "uses"}`,
    noUsages: "No usages yet.",
    usageKind: { block: "Text block", command: "Command", faq: "FAQ", timer: "Timer", overlay: "Overlay", event: "Event" },
    roleConditionHint: "Role conditions only match in chat commands; they are always false in events, overlays, and timers.",
    inputContextWarning: "This template uses chat command input. Outside commands, the variable's usage or error text appears.",
    filterAny: "All games",
    variantsCount: (count) => `${String(count)} ${count === 1 ? "variant" : "variants"}`,
    gameMultiSelect: {
      label: "Twitch games",
      hint: "Search and select games from Twitch categories.",
      search: "Search games",
      searchHint: "Enter at least two characters.",
      loading: "Searching games …",
      empty: "No games found.",
      error: "Twitch games could not be loaded.",
      suggestions: "Suggestions",
      allGames: "All games",
      limitReached: "10-game limit reached; remove one to add another.",
      selectedCount: (count, maximum) => `${String(count)} of ${String(maximum)}`,
      remove: (name) => `Remove ${name}`,
    },
    categoryLabels: { social: "Social", info: "Info", faq: "FAQ", game: "Game", fun: "Fun" },
    weekdaysLabels: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    errors: {
      text_library_block_exists: "This name is already in use.",
      text_library_block_reserved_name: "This name is reserved for a template variable.",
      text_library_block_conflict: "This text block has changed since you opened it.",
      text_library_block_rename_too_long: "The new name would exceed the maximum text length in a place that uses this block.",
      text_library_block_limit: "This channel already has 200 text blocks.",
      text_library_block_invalid: "Check the text block name, category, conditions, and texts.",
      text_library_template_usage_invalid: "This change is incompatible with at least one template that uses this text block.",
      text_library_reference_cycle: "A circular reference was detected.",
      text_library_reference_depth_exceeded: "Nesting exceeds the maximum depth of 3.",
      text_library_category_not_found: "This category no longer exists.",
      text_library_category_not_empty: "A category can only be deleted when it is empty.",
      text_library_management_denied: "Only broadcasters and managers can save changes.",
      text_library_category_limit: "A channel can have up to 25 categories.",
    },
  },
};

export const textLibraryTexts = (language?: DashboardLanguage): TextLibraryTexts => catalog[language ?? dashboardLanguage()];
