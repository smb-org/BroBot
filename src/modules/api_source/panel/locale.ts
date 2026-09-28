import type { ModuleLanguage } from "../../contract";

export interface ApiSourcePanelTexts {
  title: string;
  explanation: string;
  sourceList: string;
  addSource: string;
  editSource: string;
  createSource: string;
  name: string;
  nameHint: string;
  url: string;
  urlHint: string;
  expression: string;
  expressionHint: string;
  save: string;
  cancel: string;
  delete: string;
  confirmDelete: string;
  deleted: string;
  saved: string;
  created: string;
  loadFailed: string;
  saveFailed: string;
  invalid: string;
  constructNotAllowed: (constructName: string) => string;
  conflict: string;
  denied: string;
  limit: string;
  empty: string;
  readOnlyReason: string;
  noExpression: string;
}

const texts: Readonly<Record<ModuleLanguage, ApiSourcePanelTexts>> = {
  de: {
    title: "Benannte API-Quellen",
    explanation: "Nur öffentlich erreichbare HTTPS-JSON-Endpunkte. Werte stehen als {api_source.value name} bereit; ein boolescher JSONata-Ausdruck kann zusätzlich als Textblock-Bedingung dienen.",
    sourceList: "Quellen",
    addSource: "Quelle hinzufügen",
    editSource: "Quelle bearbeiten",
    createSource: "Quelle anlegen",
    name: "Name",
    nameHint: "Kleinbuchstaben, Ziffern und Unterstriche; beginnt mit einem Buchstaben.",
    url: "HTTPS-URL",
    urlHint: "Keine Zugangsdaten in der URL. Anfragen senden keine Cookies oder Zugangsdaten.",
    expression: "JSONata-Ausdruck (optional)",
    expressionHint: "Erlaubt: Feldpfade mit [nichtnegativem Ganzzahlindex], String-/Zahlen-/Boolesche-/Null-Literale, + - * / %, Vergleiche, and/or, &, ?: sowie direkte Aufrufe von $string $number $boolean $not $exists $length $substring $substringBefore $substringAfter $uppercase $lowercase $trim $contains $join $sum $max $min $average $count $round $floor $ceil $abs $formatNumber $fromMillis $toMillis $now $split $replace. Keine freien Prädikate oder Array-/Objektkonstruktoren. Beispiele: $fromMillis($toMillis($.daily.sunset[0]), '[H01]:[m01]') · $formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'.",
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Quelle löschen",
    confirmDelete: "Noch einmal klicken, um diese Quelle zu löschen.",
    deleted: "Die API-Quelle wurde gelöscht.",
    saved: "Die API-Quelle wurde gespeichert.",
    created: "Die API-Quelle wurde angelegt.",
    loadFailed: "Die API-Quellen konnten nicht geladen werden.",
    saveFailed: "Die API-Quelle konnte nicht gespeichert werden.",
    invalid: "Name, HTTPS-URL oder JSONata-Ausdruck ist ungültig oder nicht erlaubt.",
    constructNotAllowed: (constructName) => `Das JSONata-Konstrukt ${constructName} ist nicht erlaubt.`,
    conflict: "Die Quelle wurde zwischenzeitlich geändert. Bitte neu laden.",
    denied: "Nur Broadcaster und Verwalter dürfen API-Quellen ändern.",
    limit: "Pro Kanal sind höchstens 20 API-Quellen erlaubt.",
    empty: "Noch keine API-Quellen angelegt.",
    readOnlyReason: "Operatoren können API-Quellen lesen, aber nicht definieren.",
    noExpression: "Die gesamte JSON-Antwort verwenden",
  },
  en: {
    title: "Named API sources",
    explanation: "Only publicly reachable HTTPS JSON endpoints. Values are available as {api_source.value name}; a boolean JSONata expression can also be used as a text-block condition.",
    sourceList: "Sources",
    addSource: "Add source",
    editSource: "Edit source",
    createSource: "Create source",
    name: "Name",
    nameHint: "Lowercase letters, digits and underscores; must start with a letter.",
    url: "HTTPS URL",
    urlHint: "Do not put credentials in the URL. Requests send no cookies or credentials.",
    expression: "JSONata expression (optional)",
    expressionHint: "Allowed: field paths with [non-negative integer indexes], string/number/boolean/null literals, + - * / %, comparisons, and/or, &, ?:, and direct calls to $string $number $boolean $not $exists $length $substring $substringBefore $substringAfter $uppercase $lowercase $trim $contains $join $sum $max $min $average $count $round $floor $ceil $abs $formatNumber $fromMillis $toMillis $now $split $replace. No free predicates or array/object constructors. Examples: $fromMillis($toMillis($.daily.sunset[0]), '[H01]:[m01]') · $formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'.",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete source",
    confirmDelete: "Click again to delete this source.",
    deleted: "The API source was deleted.",
    saved: "The API source was saved.",
    created: "The API source was created.",
    loadFailed: "API sources could not be loaded.",
    saveFailed: "The API source could not be saved.",
    invalid: "The name, HTTPS URL, or JSONata expression is invalid or not allowed.",
    constructNotAllowed: (constructName) => `The JSONata construct ${constructName} is not allowed.`,
    conflict: "The source changed in another session. Reload and try again.",
    denied: "Only the broadcaster and managers may change API sources.",
    limit: "A channel can define at most 20 API sources.",
    empty: "No API sources have been defined yet.",
    readOnlyReason: "Operators can read API sources but cannot define them.",
    noExpression: "Use the complete JSON response",
  },
};

export const apiSourcePanelTexts = (language: ModuleLanguage): ApiSourcePanelTexts => texts[language];
