import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";
import { chatVotingDurationVariableCatalog, chatVotingOptionsVariableCatalog, chatVotingResultVariableCatalog, chatVotingTitleVariableCatalog } from "../contracts/template-variable-catalog";

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maximum) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maximum)} ab.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count) => `${String(count)} characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maximum) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maximum)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

const variables = (language: DashboardLanguage) => [
  { name: "vote.result", ...chatVotingResultVariableCatalog[language] },
  { name: "vote.title", ...chatVotingTitleVariableCatalog[language] },
  { name: "vote.options", ...chatVotingOptionsVariableCatalog[language] },
  { name: "vote.duration", ...chatVotingDurationVariableCatalog[language] },
];

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    title: "Abstimmungseinstellungen", ariaLabel: "Abstimmungseinstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen die Einstellungen ändern.",
    saveLabel: "Einstellungen speichern", discardLabel: "Verwerfen", savedLabel: "Einstellungen gespeichert.", pendingLabel: "Wird gespeichert …",
    invalidMessage: "Bitte korrigiere die markierten Felder.", numberMissing: "Zahl eingeben",
    issueLabels: { error: "Fehler", warning: "Hinweis" }, saveError: "Die Einstellungen konnten nicht gespeichert werden.",
    conflictMessage: "Die Einstellungen wurden inzwischen geändert.", reloadLabel: "Serverstand laden", enabledLabel: "An", disabledLabel: "Aus",
    templateMessages: templateMessages.de,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid" ? `Ungültige Variablenparameter: ${warning.invalidVariables.join(", ")}` : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    sections: { general: "Allgemein", messages: "Nachrichten" },
    fields: {
      autoCloseSeconds: { label: "Standarddauer", hint: "Gilt als Vorbelegung für neue Abstimmungen. Ohne Timer endet die Abstimmung nach vier Stunden.", unit: "s", zeroValueLabel: "Aus" },
      startText: { label: "Starttext", hint: "Wird beim Start im Chat gesendet. Leer lassen, um die Meldung auszuschalten.", previewLabel: "Vorschau", previewSpeaker: "Bot", variables: variables("de") },
      announceResult: { label: "Ergebnis im Chat senden", hint: "Wird über die gemeinsame Chat-Ausgabebegrenzung gesendet.", description: "Sendet das Ergebnis nach dem Schließen im Chat." },
      resultText: { label: "Ergebnistext", hint: "{vote.result} enthält Beschriftung, Stimmenzahl und Prozent je Option. {vote.title} enthält die Frage, {vote.options} erklärt die Abstimmung und {vote.duration} ihre Dauer.", requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot", variables: variables("de") },
      resultTarget: { label: "Ziel des Ergebnisses", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" } } },
    },
  },
  en: {
    title: "Voting settings", ariaLabel: "Voting settings",
    readOnlyReason: "Only broadcasters and managers may change these settings.",
    saveLabel: "Save settings", discardLabel: "Discard", savedLabel: "Settings saved.", pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number",
    issueLabels: { error: "Error", warning: "Note" }, saveError: "Settings could not be saved.",
    conflictMessage: "Settings have changed since they were loaded.", reloadLabel: "Load server version", enabledLabel: "On", disabledLabel: "Off",
    templateMessages: templateMessages.en,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid" ? `Invalid variable parameters: ${warning.invalidVariables.join(", ")}` : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    sections: { general: "General", messages: "Messages" },
    fields: {
      autoCloseSeconds: { label: "Default duration", hint: "Prefills new votes. Without a timer, the vote ends after four hours.", unit: "s", zeroValueLabel: "Off" },
      startText: { label: "Start text", hint: "Sent in chat when a vote starts. Leave blank to turn off the announcement.", previewLabel: "Preview", previewSpeaker: "Bot", variables: variables("en") },
      announceResult: { label: "Send the result in chat", hint: "Uses the shared automated chat output limit.", description: "Sends the result to chat after closing." },
      resultText: { label: "Result text", hint: "{vote.result} contains each option label, vote count, and percentage. {vote.title} contains the question, {vote.options} explains how to vote, and {vote.duration} gives its duration.", requiredError: "Enter text", previewLabel: "Preview", previewSpeaker: "Bot", variables: variables("en") },
      resultTarget: { label: "Result target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" } } },
    },
  },
};

export const chatVotingSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
