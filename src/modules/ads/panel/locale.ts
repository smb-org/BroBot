import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

export interface AdsPanelTexts {
  title: string;
  scheduleSection: string;
  noAdBreak: string;
  scheduledTime: string;
  asOf: (timestamp: string) => string;
  duration: string;
  snoozeSection: string;
  snoozeButton: (count: string, refresh: string) => string;
  snoozeScopeMissing: string;
  snoozeNone: string;
  snoozeUnknown: string;
  snoozeSuccess: string;
  snoozeError: string;
  recentSection: string;
  noRecent: string;
  recentDuration: (duration: string) => string;
  recentTime: (timestamp: string) => string;
  loading: string;
  loadError: string;
  immediateTitle: string;
  immediateLength: string;
  immediateLengthHint: string;
  immediateRun: (length: string) => string;
  immediateStarted: (length: string) => string;
  immediateOffline: string;
  immediateFailed: string;
}

const panelCatalog: LocaleCatalog<AdsPanelTexts> = {
  de: {
    title: "Ansagen",
    scheduleSection: "Nächste Werbung",
    noAdBreak: "Derzeit ist keine Werbung geplant.",
    scheduledTime: "Zeitpunkt",
    asOf: (timestamp) => `Stand ${timestamp}`,
    duration: "Dauer",
    snoozeSection: "Werbung verschieben",
    snoozeButton: (count, refresh) => `Snooze · ${count} verfügbar · Aufladung ${refresh}`,
    snoozeScopeMissing: "Snooze ist deaktiviert: channel:manage:ads fehlt.",
    snoozeNone: "Snooze ist deaktiviert: keine Verschiebung mehr verfügbar.",
    snoozeUnknown: "Snooze ist deaktiviert: der Twitch-Zähler ist nicht verfügbar.",
    snoozeSuccess: "Die nächste Werbepause wurde verschoben.",
    snoozeError: "Die nächste Werbepause konnte nicht verschoben werden.",
    recentSection: "Letzte Werbepausen",
    noRecent: "Noch keine Werbepausen im Ereignisprotokoll.",
    recentDuration: (duration) => `${duration} Sekunden`,
    recentTime: (timestamp) => timestamp,
    loading: "Werbeplan wird geladen …",
    loadError: "Der Werbeplan konnte nicht geladen werden.",
    immediateTitle: "Werbung",
    immediateLength: "Werbedauer",
    immediateLengthHint: "Sekunden. Startet sofort.",
    immediateRun: (length) => `Werbung jetzt (${length}s)`,
    immediateStarted: (length) => `Werbung gestartet (${length}s)`,
    immediateOffline: "Der Stream ist offline.",
    immediateFailed: "Die Werbeeinblendung konnte nicht gestartet werden.",
  },
  en: {
    title: "Announcements",
    scheduleSection: "Next ad break",
    noAdBreak: "No ad break is currently scheduled.",
    scheduledTime: "Time",
    asOf: (timestamp) => `As of ${timestamp}`,
    duration: "Duration",
    snoozeSection: "Postpone an ad break",
    snoozeButton: (count, refresh) => `Snooze · ${count} available · refresh ${refresh}`,
    snoozeScopeMissing: "Snooze is disabled: channel:manage:ads is missing.",
    snoozeNone: "Snooze is disabled: no postponements remain.",
    snoozeUnknown: "Snooze is disabled: Twitch did not provide a counter.",
    snoozeSuccess: "The next ad break was postponed.",
    snoozeError: "The next ad break could not be postponed.",
    recentSection: "Recent ad breaks",
    noRecent: "No ad breaks are in the event log yet.",
    recentDuration: (duration) => `${duration} seconds`,
    recentTime: (timestamp) => timestamp,
    loading: "Loading the ad schedule …",
    loadError: "The ad schedule could not be loaded.",
    immediateTitle: "Ads",
    immediateLength: "Ad length",
    immediateLengthHint: "Seconds. Starts immediately.",
    immediateRun: (length) => `Run ad now (${length}s)`,
    immediateStarted: (length) => `Ad started (${length}s)`,
    immediateOffline: "The stream is offline.",
    immediateFailed: "The commercial could not be started.",
  },
};

export const adsPanelTexts = (language: DashboardLanguage): AdsPanelTexts => panelCatalog[language];

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maxLength) => `${String(count)} von ${String(maxLength)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unbekannte Variable {${name}} — wird wörtlich gesendet. Nutze den Variablen-Picker.`
      : `Unbekannte Variable {${name}} — wird wörtlich gesendet. Meintest du {${suggestion}}? Nutze den Variablen-Picker.`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    worstCaseLength: (length, maxLength) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maxLength)} ab.`,
    variablePicker: {
      triggerLabel: "Variable einfügen", title: "Variable auswählen", searchLabel: "Variablen suchen", closeLabel: "Variablenauswahl schließen",
      noResults: "Keine Variablen gefunden.", createVariableLabel: "Variable anlegen …", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { context: "Kontext", stream: "Stream", person: "Person", command: "Befehl", time_random: "Zeit & Zufall", event: "Ereignis", channel: "Kanalvariablen" },
    },
  },
  en: {
    countLabel: (count, maxLength) => `${String(count)} of ${String(maxLength)} characters`,
    previewCountLabel: (count) => `${String(count)} characters`,
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unknown variable {${name}} — it will be sent literally. Use the variable picker.`
      : `Unknown variable {${name}} — it will be sent literally. Did you mean {${suggestion}}? Use the variable picker.`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    worstCaseLength: (length, maxLength) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maxLength)}.`,
    variablePicker: {
      triggerLabel: "Insert variable", title: "Choose a variable", searchLabel: "Search variables", closeLabel: "Close variable picker",
      noResults: "No variables found.", createVariableLabel: "Create variable …", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { context: "Context", stream: "Stream", person: "Person", command: "Command", time_random: "Time & random", event: "Event", channel: "Channel variables" },
    },
  },
};

const editorCatalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    title: "Ansagen-Einstellungen", ariaLabel: "Ansagen-Einstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen Ansagen-Einstellungen ändern.",
    saveLabel: "Ansagen speichern", discardLabel: "Verwerfen", savedLabel: "Ansagen gespeichert.", pendingLabel: "Wird gespeichert …",
    invalidMessage: "Bitte korrigiere die markierten Felder.", numberMissing: "Zahl eingeben",
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    loadError: "Die Ansagen-Einstellungen konnten nicht geladen werden.", saveError: "Die Ansagen-Einstellungen konnten nicht gespeichert werden.",
    conflictMessage: "Ansagen-Einstellungen wurden inzwischen geändert.", reloadLabel: "Serverstand laden", enabledLabel: "An", disabledLabel: "Aus",
    templateMessages: templateMessages.de,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unbekannte Variable${warning.unknownVariables.length === 1 ? "" : "n"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Ungültige Variablenparameter: ${warning.invalidVariables.join(", ")}`
        : `Vorlage kann ${String(warning.worstCaseLength)} Zeichen lang sein.`,
    sections: { announcements: "Ansagen", prewarning: "Vorwarnung" },
    fields: {
      automatic: {
        label: "Automatische Werbepause", hint: "Geht raus, wenn eine geplante Werbung beginnt. Ohne {duration} ergänzt die Vorschau (N Sekunden).",
        requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "duration", description: "Dauer der Werbepause in Sekunden", sample: "90" }],
      },
      manual: {
        label: "Manuell gestartete Werbepause", hint: "Geht raus, wenn jemand die Werbung von Hand startet. Ohne {duration} ergänzt die Vorschau (N Sekunden).",
        requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "duration", description: "Dauer der Werbepause in Sekunden", sample: "90" }],
      },
      prewarning: { label: "Vorwarnung vor der Werbung", hint: "Kündigt die nächste Werbung vorher im Chat an.", description: "Kündigt die nächste Werbung vorher im Chat an." },
      leadSeconds: { label: "Vorlaufzeit", hint: "So lange vor der Werbung. 30 bis 300.", unit: "s", disabledReason: "Vorwarnung ist ausgeschaltet.", increaseLabel: "Vorlaufzeit erhöhen", decreaseLabel: "Vorlaufzeit verringern" },
      prewarningText: {
        label: "Vorwarnungstext", hint: "Was der Bot vor der Werbung schreibt.", requiredError: "Text eingeben",
        previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "seconds", description: "Verbleibende Sekunden bis zur Werbung", sample: "60" }],
      },
    },
  },
  en: {
    title: "Announcement settings", ariaLabel: "Announcement settings",
    readOnlyReason: "Only broadcasters and managers may change announcement settings.",
    saveLabel: "Save announcements", discardLabel: "Discard", savedLabel: "Announcements saved.", pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number",
    issueLabels: { error: "Error", warning: "Warning" },
    loadError: "Announcement settings could not be loaded.", saveError: "Announcement settings could not be saved.",
    conflictMessage: "Announcement settings have changed since they were loaded.", reloadLabel: "Load server version", enabledLabel: "On", disabledLabel: "Off",
    templateMessages: templateMessages.en,
    warningLabel: (warning) => warning.code === "unknown_template_variables"
      ? `Unknown variable${warning.unknownVariables.length === 1 ? "" : "s"}: ${warning.unknownVariables.map((name) => `{${name}}`).join(", ")}`
      : warning.code === "template_parameters_invalid"
        ? `Invalid variable parameters: ${warning.invalidVariables.join(", ")}`
        : `Template can be ${String(warning.worstCaseLength)} characters long.`,
    sections: { announcements: "Announcements", prewarning: "Prewarning" },
    fields: {
      automatic: {
        label: "Automatic ad break", hint: "Sent when a scheduled ad break starts. If {duration} is missing, the preview adds (N seconds).", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "duration", description: "Ad break duration in seconds", sample: "90" }],
      },
      manual: {
        label: "Manually started ad break", hint: "Sent when someone starts an ad break by hand. If {duration} is missing, the preview adds (N seconds).", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "duration", description: "Ad break duration in seconds", sample: "90" }],
      },
      prewarning: { label: "Warn before an ad break", hint: "Announces the next ad break in chat beforehand.", description: "Announces the next ad break in chat beforehand." },
      leadSeconds: { label: "Lead time", hint: "How long before the ad break. 30 to 300.", unit: "s", disabledReason: "Prewarning is turned off.", increaseLabel: "Increase lead time", decreaseLabel: "Decrease lead time" },
      prewarningText: {
        label: "Prewarning text", hint: "What the bot says before the ad break.", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "seconds", description: "Seconds remaining until the ad break", sample: "60" }],
      },
    },
  },
};

export const adsSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => editorCatalog[language];
