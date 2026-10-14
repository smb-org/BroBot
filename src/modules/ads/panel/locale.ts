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
  rateLimited: (seconds: number) => string;
  snoozeReadOnly: string;
  snoozeNone: string;
  snoozeUnknown: string;
  snoozeSuccess: string;
  snoozeError: string;
  recentSection: string;
  noRecent: string;
  recentDuration: (duration: string) => string;
  loading: string;
  loadError: string;
  refreshSchedule: string;
  refreshReadOnly: string;
  refreshSuccess: string;
  refreshError: string;
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
    snoozeScopeMissing: "Snooze braucht die Berechtigung channel:manage:ads. Autorisiere Ads für diesen Kanal erneut und erteile diese Berechtigung.",
    rateLimited: (seconds) => `Twitch begrenzt die Anfragen gerade. Versuche es in ${String(seconds)} Sekunden erneut.`,
    snoozeReadOnly: "Nur Broadcaster und Verwalter dürfen Werbepausen verschieben.",
    snoozeNone: "Snooze ist deaktiviert: keine Verschiebung mehr verfügbar.",
    snoozeUnknown: "Snooze ist deaktiviert: der Twitch-Zähler ist nicht verfügbar.",
    snoozeSuccess: "Die nächste Werbepause wurde verschoben.",
    snoozeError: "Die nächste Werbepause konnte nicht verschoben werden.",
    recentSection: "Letzte Werbepausen",
    noRecent: "Noch keine Werbepausen im Ereignisprotokoll.",
    recentDuration: (duration) => `${duration} Sekunden`,
    loading: "Werbeplan wird geladen …",
    loadError: "Der Werbeplan konnte nicht geladen werden.",
    refreshSchedule: "Werbeplan aktualisieren",
    refreshReadOnly: "Nur Broadcaster und Verwalter dürfen den Werbeplan aktualisieren.",
    refreshSuccess: "Der Werbeplan wurde aktualisiert.",
    refreshError: "Der Werbeplan konnte nicht aktualisiert werden.",
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
    snoozeScopeMissing: "Snooze needs the channel:manage:ads permission. Reauthorize Ads for this channel and grant this permission.",
    rateLimited: (seconds) => `Twitch is rate limiting requests. Try again in ${String(seconds)} seconds.`,
    snoozeReadOnly: "Only broadcasters and managers may snooze ad breaks.",
    snoozeNone: "Snooze is disabled: no postponements remain.",
    snoozeUnknown: "Snooze is disabled: Twitch did not provide a counter.",
    snoozeSuccess: "The next ad break was postponed.",
    snoozeError: "The next ad break could not be postponed.",
    recentSection: "Recent ad breaks",
    noRecent: "No ad breaks are in the event log yet.",
    recentDuration: (duration) => `${duration} seconds`,
    loading: "Loading the ad schedule …",
    loadError: "The ad schedule could not be loaded.",
    refreshSchedule: "Refresh ad schedule",
    refreshReadOnly: "Only broadcasters and managers may refresh the ad schedule.",
    refreshSuccess: "The ad schedule was refreshed.",
    refreshError: "The ad schedule could not be refreshed.",
  },
};

export const adsPanelTexts = (language: DashboardLanguage): AdsPanelTexts => panelCatalog[language];

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maxLength) => `${String(count)} von ${String(maxLength)} Zeichen`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unbekannte Variable {${name}}.`
      : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length, maxLength) => `Mit den längsten Werten bis zu ${String(length)} Zeichen — Twitch lehnt Nachrichten über ${String(maxLength)} ab.`,
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maxLength) => `${String(count)} of ${String(maxLength)} characters`,
    previewCountLabel: (count) => `${String(count)} characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null
      ? `Unknown variable {${name}}.`
      : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length, maxLength) => `With the longest values, this can reach ${String(length)} characters — Twitch rejects messages over ${String(maxLength)}.`,
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
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
    saveError: "Die Ansagen-Einstellungen konnten nicht gespeichert werden.",
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
        label: "Automatische Werbepause", hint: "Geht raus, wenn eine geplante Werbung beginnt. Ohne {ads.duration} ergänzt die Vorschau (N Sekunden).",
        requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "ads.duration", description: "Dauer der Werbepause in Sekunden", sample: "90" }],
      },
      automaticTarget: { label: "Ziel der automatischen Werbepause", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" } } },
      manual: {
        label: "Manuell gestartete Werbepause", hint: "Geht raus, wenn jemand die Werbung von Hand startet. Ohne {ads.duration} ergänzt die Vorschau (N Sekunden).",
        requiredError: "Text eingeben", previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "ads.duration", description: "Dauer der Werbepause in Sekunden", sample: "90" }],
      },
      manualTarget: { label: "Ziel der manuell gestarteten Werbepause", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" } } },
      prewarning: { label: "Vorwarnung vor der Werbung", hint: "Kündigt die nächste Werbung vorher im Chat an.", description: "Kündigt die nächste Werbung vorher im Chat an." },
      leadSeconds: { label: "Vorlaufzeit", hint: "So lange vor der Werbung. 30 bis 300.", unit: "s", disabledReason: "Vorwarnung ist ausgeschaltet." },
      prewarningText: {
        label: "Vorwarnungstext", hint: "Was der Bot vor der Werbung schreibt.", requiredError: "Text eingeben",
        previewLabel: "Vorschau", previewSpeaker: "Bot",
        variables: [{ name: "ads.seconds", description: "Verbleibende Sekunden bis zur Werbung", sample: "60" }],
      },
      prewarningTarget: { label: "Ziel der Vorwarnung", hint: "Wirkt nur während eines Shared Chats.", options: { all_chats: { label: "Alle Chats" }, source_only: { label: "Nur unser Chat" } } },
    },
  },
  en: {
    title: "Announcement settings", ariaLabel: "Announcement settings",
    readOnlyReason: "Only broadcasters and managers may change announcement settings.",
    saveLabel: "Save announcements", discardLabel: "Discard", savedLabel: "Announcements saved.", pendingLabel: "Saving …",
    invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number",
    issueLabels: { error: "Error", warning: "Warning" },
    saveError: "Announcement settings could not be saved.",
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
        label: "Automatic ad break", hint: "Sent when a scheduled ad break starts. If {ads.duration} is missing, the preview adds (N seconds).", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "ads.duration", description: "Ad break duration in seconds", sample: "90" }],
      },
      automaticTarget: { label: "Automatic ad break target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" } } },
      manual: {
        label: "Manually started ad break", hint: "Sent when someone starts an ad break by hand. If {ads.duration} is missing, the preview adds (N seconds).", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "ads.duration", description: "Ad break duration in seconds", sample: "90" }],
      },
      manualTarget: { label: "Manually started ad break target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" } } },
      prewarning: { label: "Warn before an ad break", hint: "Announces the next ad break in chat beforehand.", description: "Announces the next ad break in chat beforehand." },
      leadSeconds: { label: "Lead time", hint: "How long before the ad break. 30 to 300.", unit: "s", disabledReason: "Prewarning is turned off." },
      prewarningText: {
        label: "Prewarning text", hint: "What the bot says before the ad break.", requiredError: "Enter text",
        previewLabel: "Preview", previewSpeaker: "Bot",
        variables: [{ name: "ads.seconds", description: "Seconds remaining until the ad break", sample: "60" }],
      },
      prewarningTarget: { label: "Prewarning target", hint: "Only affects output during Shared Chat.", options: { all_chats: { label: "All chats" }, source_only: { label: "Only our chat" } } },
    },
  },
};

export const adsSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => editorCatalog[language];
