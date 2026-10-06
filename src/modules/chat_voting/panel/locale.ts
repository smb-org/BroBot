import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages = {
  de: {
    countLabel: (count: number, maximum: number) => `${String(count)} von ${String(maximum)} Zeichen`,
    previewCountLabel: (count: number) => `${String(count)} Zeichen`,
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unbekannte Variable {${name}} — wird wörtlich gesendet. Nutze den Variablen-Picker.`
      : `Unbekannte Variable {${name}} — wird wörtlich gesendet. Meintest du {${suggestion}}? Nutze den Variablen-Picker.`,
    insertSuggestionLabel: (name: string) => `{${name}} einsetzen`,
    worstCaseLength: (length: number, maximum: number) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maximum)} ab.`,
    variablePicker: {
      triggerLabel: "Variable einfügen", title: "Variable auswählen", searchLabel: "Variablen suchen", closeLabel: "Variablenauswahl schließen",
      noResults: "Keine Variablen gefunden.", createVariableLabel: "Variable anlegen …", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { context: "Kontext", stream: "Stream", person: "Person", command: "Befehl", time_random: "Zeit & Zufall", event: "Ereignis", channel: "Kanalvariablen", text_blocks: "Textblöcke" },
      textBlockSample: "Textblock", keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count: number, maximum: number) => `${String(count)} of ${String(maximum)} characters`,
    previewCountLabel: (count: number) => `${String(count)} characters`,
    unknownVariable: (name: string, suggestion: string | null) => suggestion === null
      ? `Unknown variable {${name}} — it will be sent literally. Use the variable picker.`
      : `Unknown variable {${name}} — it will be sent literally. Did you mean {${suggestion}}? Use the variable picker.`,
    insertSuggestionLabel: (name: string) => `Insert {${name}}`,
    worstCaseLength: (length: number, maximum: number) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maximum)}.`,
    variablePicker: {
      triggerLabel: "Insert variable", title: "Choose a variable", searchLabel: "Search variables", closeLabel: "Close variable picker",
      noResults: "No variables found.", createVariableLabel: "Create variable …", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { context: "Context", stream: "Stream", person: "Person", command: "Command", time_random: "Time and random", event: "Event", channel: "Channel variables", text_blocks: "Text blocks" },
      textBlockSample: "Text block", keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
} satisfies LocaleCatalog<SettingsEditorCatalog["templateMessages"]>;

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    title: "Abstimmungseinstellungen", ariaLabel: "Abstimmungseinstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen die Einstellungen ändern.",
    saveLabel: "Einstellungen speichern", discardLabel: "Verwerfen", savedLabel: "Einstellungen gespeichert.", pendingLabel: "Wird gespeichert …",
    invalidMessage: "Bitte korrigiere die markierten Felder.", numberMissing: "Zahl eingeben",
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    loadError: "Die Einstellungen konnten nicht geladen werden.", saveError: "Die Einstellungen konnten nicht gespeichert werden.",
    conflictMessage: "Die Einstellungen wurden inzwischen geändert.", reloadLabel: "Serverstand laden", enabledLabel: "An", disabledLabel: "Aus",
    templateMessages: templateMessages.de,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Ungültige Variablenparameter: ${warning.invalidVariables.join(", ")}`
        : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    sections: { labels: "Beschriftungen", result: "Ergebnis" },
    fields: {
      yesNoLabels: { label: "Ja/Nein-Beschriftungen", hint: "Zwei Texte mit | trennen. Leer lassen für die Standardwerte.", placeholder: "Ja|Nein", invalidError: "Gib genau zwei Texte mit jeweils höchstens 32 Zeichen ein." },
      zeroOneLabels: { label: "0/1-Beschriftungen", hint: "Beschriftungen für 0 und 1 mit | trennen. Leer lassen für Nein|Ja.", placeholder: "Nein|Ja", invalidError: "Gib genau zwei Texte mit jeweils höchstens 32 Zeichen ein." },
      oneTwoLabels: { label: "1/2-Beschriftungen", hint: "Beschriftungen für 1 und 2 mit | trennen. Leer lassen für 1|2.", placeholder: "1|2", invalidError: "Gib genau zwei Texte mit jeweils höchstens 32 Zeichen ein." },
      scaleLabels: { label: "Skalen-Beschriftungen", hint: "Fünf Texte mit | trennen. Leer lassen für die Zahlen 1 bis 5.", placeholder: "1|2|3|4|5", invalidError: "Gib genau fünf Texte mit jeweils höchstens 32 Zeichen ein." },
      optionLabels: { label: "Beschriftungen für 2–9 Optionen", hint: "Zwei bis neun Texte mit | trennen. Leer lassen für die Optionsnummern.", placeholder: "1|2|3|…|9", invalidError: "Gib zwei bis neun Texte mit jeweils höchstens 32 Zeichen ein." },
      autoCloseSeconds: { label: "Automatisch schließen", hint: "Aus bedeutet: kein Timer. Ohne Timer endet die Abstimmung nach vier Stunden.", unit: "s", zeroValueLabel: "Aus", increaseLabel: "Schließzeit erhöhen", decreaseLabel: "Schließzeit verringern" },
      announceResult: { label: "Ergebnis im Chat senden", hint: "Wird über die gemeinsame Chat-Ausgabebegrenzung gesendet.", description: "Sendet das Ergebnis nach dem Schließen im Chat." },
      resultText: { label: "Ergebnistext", hint: "{vote.result} enthält Beschriftung, Stimmenzahl und Prozent je Option.", requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot", variables: [{ name: "vote.result", description: "Beschriftungen, Stimmen und Prozentwerte des Ergebnisses", sample: "Ja: 8 (67%) · Nein: 4 (33%)" }] },
      resultTarget: { label: "Ziel des Ergebnisses", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" } } },
    },
  },
  en: {
    title: "Voting settings", ariaLabel: "Voting settings",
    readOnlyReason: "Only broadcasters and managers may change these settings.",
    saveLabel: "Save settings", discardLabel: "Discard", savedLabel: "Settings saved.", pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number",
    issueLabels: { error: "Error", warning: "Note" },
    loadError: "Settings could not be loaded.", saveError: "Settings could not be saved.",
    conflictMessage: "Settings have changed since they were loaded.", reloadLabel: "Load server version", enabledLabel: "On", disabledLabel: "Off",
    templateMessages: templateMessages.en,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Invalid variable parameters: ${warning.invalidVariables.join(", ")}`
        : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    sections: { labels: "Labels", result: "Results" },
    fields: {
      yesNoLabels: { label: "Yes/no labels", hint: "Separate two labels with |. Leave blank to use the defaults.", placeholder: "Yes|No", invalidError: "Enter exactly two labels of up to 32 characters each." },
      zeroOneLabels: { label: "0/1 labels", hint: "Separate labels for 0 and 1 with |. Leave blank to use No|Yes.", placeholder: "No|Yes", invalidError: "Enter exactly two labels of up to 32 characters each." },
      oneTwoLabels: { label: "1/2 labels", hint: "Separate labels for 1 and 2 with |. Leave blank to use 1|2.", placeholder: "1|2", invalidError: "Enter exactly two labels of up to 32 characters each." },
      scaleLabels: { label: "Scale labels", hint: "Separate five labels with |. Leave blank to use 1 through 5.", placeholder: "1|2|3|4|5", invalidError: "Enter exactly five labels of up to 32 characters each." },
      optionLabels: { label: "Labels for 2–9 options", hint: "Separate two to nine labels with |. Leave blank to use option numbers.", placeholder: "1|2|3|…|9", invalidError: "Enter two to nine labels of up to 32 characters each." },
      autoCloseSeconds: { label: "Auto close", hint: "Off means there is no timer. Without a timer, the vote ends after four hours.", unit: "s", zeroValueLabel: "Off", increaseLabel: "Increase close time", decreaseLabel: "Decrease close time" },
      announceResult: { label: "Send the result in chat", hint: "Uses the shared automated chat output limit.", description: "Sends the result to chat after closing." },
      resultText: { label: "Result text", hint: "{vote.result} contains each option label, vote count, and percentage.", requiredError: "Enter text", previewLabel: "Preview", previewSpeaker: "Bot", variables: [{ name: "vote.result", description: "Labels, counts, and percentages from the result", sample: "Yes: 8 (67%) · No: 4 (33%)" }] },
      resultTarget: { label: "Result target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" } } },
    },
  },
};

export const chatVotingSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
