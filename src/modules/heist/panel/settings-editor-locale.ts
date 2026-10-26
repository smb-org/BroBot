import type { DashboardLanguage } from "../../../dashboard/locale";
import type { SettingsEditorCatalog, TemplateTextFieldMessages } from "../../../dashboard/ui";
import type { PanelTemplateWarning } from "../../contract";
import { heistCatalog } from "../locale";

const templateMessages: Readonly<Record<DashboardLanguage, TemplateTextFieldMessages>> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Bis zu ${String(length)} Zeichen; Twitch lehnt Nachrichten über ${String(maximum)} Zeichen ab.`,
    picker: { title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "", groupLabels: { channel: "Kanal", module: "Modul", own: "Eigene", text_blocks: "Textbausteine" }, keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" } },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} ${count === 1 ? "character" : "characters"}`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `Up to ${String(length)} characters; Twitch rejects messages over ${String(maximum)} characters.`,
    picker: { title: "Choose a variable", noResults: "No variables found.", externalHelp: "", groupLabels: { channel: "Channel", module: "Module", own: "Own", text_blocks: "Text blocks" }, keyHints: { navigate: "select", insert: "insert", close: "close" } },
  },
};

const catalog = (language: DashboardLanguage): SettingsEditorCatalog => {
  const de = language === "de";
  const copy = heistCatalog[language];
  const settingsChanged = de ? "Einstellungen wurden inzwischen geändert." : "Settings have changed since they were loaded.";
  return {
    title: copy.title,
    ariaLabel: copy.title,
    readOnlyReason: de ? "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern." : "Only broadcasters and managers may change these settings.",
    saveLabel: de ? "Speichern" : "Save",
    discardLabel: de ? "Verwerfen" : "Discard",
    savedLabel: de ? "Gespeichert" : "Saved",
    pendingLabel: de ? "Wird gespeichert …" : "Saving …",
    invalidMessage: de ? "Bitte die markierten Felder prüfen." : "Please check the highlighted fields.",
    numberMissing: de ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: de ? "Fehler" : "Error", warning: de ? "Hinweis" : "Notice" },
    saveError: de ? "Die Einstellungen konnten nicht gespeichert werden." : "The settings could not be saved.",
    conflictMessage: settingsChanged,
    reloadLabel: de ? "Serverstand laden" : "Load server version",
    enabledLabel: de ? "An" : "On",
    disabledLabel: de ? "Aus" : "Off",
    messageEnabledLabel: de ? "Nachricht senden" : "Send message",
    templateMessages: templateMessages[language],
    warningLabel: (warning: PanelTemplateWarning) => warning.code === "unknown_template_variables"
      ? `${de ? "Unbekannte Variablen" : "Unknown variables"}: ${warning.unknownVariables.join(", ")}`
      : warning.code === "template_worst_case_too_long"
        ? `${de ? "Vorlage kann" : "Template can be"} ${String(warning.worstCaseLength)} ${de ? "Zeichen lang sein." : "characters long."}`
        : `${de ? "Ungültige Variablen" : "Invalid variables"}: ${warning.invalidVariables.join(", ")}`,
    sections: {
      stakes: de ? "Einsätze" : "Stakes",
      round: de ? "Rundenregeln" : "Round rules",
      chance: de ? "Erfolgschance" : "Success chance",
      messages: de ? "Chat-Nachrichten" : "Chat messages",
    },
    fields: {
      minStake: { label: de ? "Mindesteinsatz" : "Minimum stake", hint: de ? "Kleinster erlaubter Einsatz pro Person." : "Smallest stake allowed per participant.", unit: de ? "Punkte" : "points", invalidError: de ? "Muss höchstens dem Maximaleinsatz entsprechen." : "Must not exceed the maximum stake." },
      maxStake: { label: de ? "Maximaleinsatz" : "Maximum stake", hint: de ? "Größter erlaubter Einsatz pro Person." : "Largest stake allowed per participant.", unit: de ? "Punkte" : "points", invalidError: de ? "Muss mindestens dem Mindesteinsatz entsprechen." : "Must be at least the minimum stake." },
      joinWindowSeconds: { label: de ? "Beitrittsfenster" : "Join window", hint: de ? "Zeit ab gesendeter Startnachricht, in der weitere Personen mitmachen können." : "Time after the start message is sent for other viewers to join.", unit: "s" },
      cooldownSeconds: { label: de ? "Pause zwischen Überfällen" : "Cooldown between heists", hint: de ? "Pause nach Ende des Beitrittsfensters vor dem nächsten Überfall." : "Wait time after the join window before the next heist can start.", unit: "s" },
      baseChance: { label: de ? "Grundchance" : "Base chance", hint: de ? "Erfolgschance mit einer teilnehmenden Person." : "Success chance with one participant.", unit: "%" },
      maxChance: { label: de ? "Maximale Chance" : "Chance cap", hint: de ? "Die Chance steigt um 2 Prozentpunkte pro weiterer Person bis zu diesem Wert." : "Chance rises by 2 percentage points per additional participant, up to this value.", unit: "%", invalidError: de ? "Muss mindestens der Grundchance entsprechen." : "Must be at least the base chance." },
      startText: { label: de ? "Startnachricht" : "Start message", hint: de ? "Wird als Antwort auf den Startbefehl gesendet." : "Sent as a reply to the command that starts the round.", requiredError: de ? "Text fehlt." : "Text is required." },
      confirmText: { label: de ? "Beitrittsliste" : "Join list", hint: de ? "Eine Zeile in der Mitte des Beitrittsfensters mit allen, die dabei sind, und dem Pott. Entfällt, solange niemand außer der startenden Person dabei ist." : "One line in the middle of the join window listing who is in and the pot. Skipped while nobody but the starter has joined.", requiredError: de ? "Text fehlt." : "Text is required." },
      resultText: { label: de ? "Ergebnisnachricht" : "Result message", hint: de ? "Eine kompakte Zusammenfassung mit Gewinnern und Verlierern." : "One compact summary with winners and losers.", requiredError: de ? "Text fehlt." : "Text is required." },
    },
  };
};

export const heistSettingsEditorCatalog = { de: catalog("de"), en: catalog("en") } as const;
