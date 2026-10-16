import type { ModuleLanguage } from "../../contract";
import type { ExpressionFieldMessages } from "./ExpressionField";

export interface ApiSourcePanelTexts {
  title: string;
  addSource: string;
  editSource: string;
  createSource: string;
  steps: { url: string; expression: string; test: string; name: string };
  stepCounter: (current: number, total: number) => string;
  continue: string;
  back: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchClearLabel: string;
  noSearchResults: string;
  selectSource: string;
  sourceExpression: string;
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
  statusError: string;
  statusUntested: string;
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
    title: "Datenquellen",
    addSource: "Quelle anlegen",
    editSource: "Quelle bearbeiten",
    createSource: "Datenquelle anlegen",
    steps: { url: "Webadresse", expression: "Wert auswählen", test: "Quelle testen", name: "Namen vergeben" },
    stepCounter: (current, total) => `Schritt ${String(current)} von ${String(total)}`,
    continue: "Weiter",
    back: "Zurück",
    searchLabel: "Datenquellen suchen",
    searchPlaceholder: "Name oder Webadresse suchen",
    searchClearLabel: "Suche leeren",
    noSearchResults: "Keine passenden Datenquellen gefunden.",
    selectSource: "Wähle eine Datenquelle aus, um ihre Angaben zu sehen.",
    sourceExpression: "Ausdruck",
    name: "Name",
    nameHint: "Kleinbuchstaben, Zahlen und Unterstriche; der Name beginnt mit einem Buchstaben.",
    url: "Webadresse",
    urlHint: "Verwende eine öffentliche HTTPS-Adresse. Anmeldedaten gehören nicht in die Adresse.",
    expression: "Wert aus der Antwort",
    expressionHint: "Gib ein Feld aus der Antwort ein oder wähle eine Funktion. Beispiel: $.temperature oder $round($.price, 2).",
    expressionPicker: {
      picker: { title: "Funktion einfügen", noResults: "Keine passende Funktion.", keyHints: { navigate: "Navigieren", insert: "Einfügen", close: "Schließen" } },
      groupLabels: { text: "Text", number: "Zahlen", logic: "Logik", list: "Listen", date: "Datum" },
      signatureLabel: "Funktionssignatur",
      insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    },
    test: "Testen",
    testing: "Wird getestet …",
    testSucceeded: (httpStatus, bytes) => `Erfolgreich · HTTP ${String(httpStatus)} · ${String(bytes)} Bytes`,
    testRequestFailed: "Der Test konnte nicht ausgeführt werden.",
    notTested: "Noch nicht abgerufen",
    statusOk: "OK",
    statusError: "Fehler",
    statusUntested: "Neu",
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Quelle löschen",
    deleteTitle: "Datenquelle löschen?",
    deleteConsequence: "Danach stehen ihre Werte nicht mehr in Chattexten oder Bedingungen zur Verfügung.",
    inUse: "Diese Datenquelle wird noch in gespeicherten Chattexten oder Bedingungen verwendet.",
    deleted: "Die Datenquelle wurde gelöscht.",
    saved: "Die Datenquelle wurde gespeichert.",
    created: "Die Datenquelle wurde angelegt.",
    loadFailed: "Die Datenquellen konnten nicht geladen werden.",
    saveFailed: "Die Datenquelle konnte nicht gespeichert werden.",
    invalid: "Der Name, die Webadresse oder der Ausdruck ist ungültig.",
    constructNotAllowed: (constructName) => `Dieser Teil des Ausdrucks ist nicht erlaubt: ${constructName}.`,
    conflict: "Die Datenquelle wurde zwischenzeitlich geändert. Bitte neu laden.",
    denied: "Nur Broadcaster und Verwalter dürfen Datenquellen ändern.",
    limit: "Pro Kanal sind höchstens 20 Datenquellen erlaubt.",
    empty: "Noch keine Datenquellen angelegt.",
    readOnlyReason: "Operatoren können Datenquellen ansehen, aber nicht ändern.",
    noExpression: "Die gesamte Antwort verwenden",
  },
  en: {
    title: "Data sources",
    addSource: "Create source",
    editSource: "Edit source",
    createSource: "Create data source",
    steps: { url: "Web address", expression: "Choose a value", test: "Test source", name: "Name the value" },
    stepCounter: (current, total) => `Step ${String(current)} of ${String(total)}`,
    continue: "Continue",
    back: "Back",
    searchLabel: "Search data sources",
    searchPlaceholder: "Search by name or web address",
    searchClearLabel: "Clear search",
    noSearchResults: "No matching data sources found.",
    selectSource: "Select a data source to see its details.",
    sourceExpression: "Expression",
    name: "Name",
    nameHint: "Use lowercase letters, digits, and underscores. Start with a letter.",
    url: "Web address",
    urlHint: "Use a public HTTPS address. Do not include sign-in details.",
    expression: "Value from the response",
    expressionHint: "Enter a field from the response or choose a function. For example: $.temperature or $round($.price, 2).",
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
    statusOk: "OK",
    statusError: "Error",
    statusUntested: "New",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete source",
    deleteTitle: "Delete data source?",
    deleteConsequence: "Its values will no longer be available to saved chat text or conditions.",
    inUse: "This data source is still used in saved chat text or conditions.",
    deleted: "The data source was deleted.",
    saved: "The data source was saved.",
    created: "The data source was created.",
    loadFailed: "Data sources could not be loaded.",
    saveFailed: "The data source could not be saved.",
    invalid: "The name, web address, or expression is invalid.",
    constructNotAllowed: (constructName) => `This part of the expression is not allowed: ${constructName}.`,
    conflict: "The data source changed in another session. Reload and try again.",
    denied: "Only the broadcaster and managers may change data sources.",
    limit: "A channel can define at most 20 data sources.",
    empty: "No data sources have been created yet.",
    readOnlyReason: "Operators can view data sources but cannot change them.",
    noExpression: "Use the complete response",
  },
};

export const apiSourcePanelTexts = (language: ModuleLanguage): ApiSourcePanelTexts => texts[language];
