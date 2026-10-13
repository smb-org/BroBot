import type { ModuleLanguage } from "../../contract";
import type { ExpressionFieldMessages } from "./ExpressionField";

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
  expressionPicker: ExpressionFieldMessages;
  test: string;
  testing: string;
  testSucceeded: (httpStatus: number, bytes: number) => string;
  testRequestFailed: string;
  notTested: string;
  statusOk: string;
  save: string;
  cancel: string;
  delete: string;
  deleteTitle: string;
  deleteConsequence: string;
  inUse: string;
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
    explanation: "Nur öffentlich erreichbare HTTPS-JSON-Endpunkte. Werte stehen als {api.<name>} bereit; ein boolescher JSONata-Ausdruck kann zusätzlich als Textblock-Bedingung dienen.",
    sourceList: "Quellen",
    addSource: "Quelle hinzufügen",
    editSource: "Quelle bearbeiten",
    createSource: "Quelle anlegen",
    name: "Name",
    nameHint: "Kleinbuchstaben, Ziffern und Unterstriche; beginnt mit einem Buchstaben.",
    url: "HTTPS-URL",
    urlHint: "Keine Zugangsdaten in der URL. Anfragen senden keine Cookies oder Zugangsdaten.",
    expression: "JSONata-Ausdruck (optional)",
    expressionHint: "Erlaubt: Feldpfade mit [nichtnegativem Ganzzahlindex], String-/Zahlen-/Boolesche-/Null-Literale, + - * / %, Vergleiche, and/or, &, ?: und direkte Funktionsaufrufe aus dem Picker. Keine freien Prädikate oder Array-/Objektkonstruktoren. Beispiele: $fromMillis($toMillis($.daily.sunset[0]), '[H01]:[m01]') · $formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'.",
    expressionPicker: {
      picker: { title: "Funktionen einfügen", noResults: "Keine passende Funktion.", keyHints: { navigate: "Navigieren", insert: "Einfügen", close: "Schließen" } },
      groupLabels: { text: "Text", number: "Zahlen", logic: "Logik", list: "Listen", date: "Datum" },
      signatureLabel: "Funktionssignatur",
      insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    },
    test: "Testen",
    testing: "Wird getestet …",
    testSucceeded: (httpStatus, bytes) => `Erfolgreich · HTTP ${String(httpStatus)} · ${String(bytes)} Bytes`,
    testRequestFailed: "Der Test konnte nicht ausgeführt werden.",
    notTested: "Noch nicht abgerufen",
    statusOk: "Erfolgreich",
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Quelle löschen",
    deleteTitle: "API-Quelle löschen?",
    deleteConsequence: "Die Quelle steht danach nicht mehr für Vorlagen und Bedingungen bereit.",
    inUse: "Diese Quelle wird noch in gespeicherten Vorlagen oder Textbaustein-Bedingungen verwendet.",
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
    explanation: "Only publicly reachable HTTPS JSON endpoints. Values are available as {api.<name>}; a boolean JSONata expression can also be used as a text-block condition.",
    sourceList: "Sources",
    addSource: "Add source",
    editSource: "Edit source",
    createSource: "Create source",
    name: "Name",
    nameHint: "Lowercase letters, digits and underscores; must start with a letter.",
    url: "HTTPS URL",
    urlHint: "Do not put credentials in the URL. Requests send no cookies or credentials.",
    expression: "JSONata expression (optional)",
    expressionHint: "Allowed: field paths with [non-negative integer indexes], string/number/boolean/null literals, + - * / %, comparisons, and/or, &, ?:, and direct function calls from the picker. No free predicates or array/object constructors. Examples: $fromMillis($toMillis($.daily.sunset[0]), '[H01]:[m01]') · $formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'.",
    expressionPicker: {
      picker: { title: "Insert function", noResults: "No matching function.", keyHints: { navigate: "Navigate", insert: "Insert", close: "Close" } },
      groupLabels: { text: "Text", number: "Number", logic: "Logic", list: "Lists", date: "Date" },
      signatureLabel: "Function signature",
      insertionLimit: "This insertion would exceed the character limit.",
    },
    test: "Test",
    testing: "Testing …",
    testSucceeded: (httpStatus, bytes) => `Success · HTTP ${String(httpStatus)} · ${String(bytes)} bytes`,
    testRequestFailed: "The test request could not be completed.",
    notTested: "Not fetched yet",
    statusOk: "Success",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete source",
    deleteTitle: "Delete API source?",
    deleteConsequence: "The source will no longer be available to templates or conditions.",
    inUse: "This source is still used by saved templates or text block conditions.",
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
