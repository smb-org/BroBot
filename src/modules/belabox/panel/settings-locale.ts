import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages: LocaleCatalog<SettingsEditorCatalog["templateMessages"]> = {
  de: {
    countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
    previewCountLabel: (count) => `${String(count)} Zeichen`,
    openBrace: "Offene Variable: Schließe die geschweifte Klammer mit } ab.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unbekannte Variable {${name}}.` : `Unbekannte Variable {${name}} – meintest du {${suggestion}}?`,
    insertSuggestionLabel: (name) => `{${name}} einsetzen`,
    insertionLimit: "Einfügen würde das Zeichenlimit überschreiten.",
    worstCaseLength: (length) => String(length),
    picker: {
      title: "Variable auswählen", noResults: "Keine Variablen gefunden.", externalHelp: "Fragt Twitch live ab, wenn die Vorlage gerendert wird",
      groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
      keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
    },
  },
  en: {
    countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
    previewCountLabel: (count) => `${String(count)} characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
    unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
    insertSuggestionLabel: (name) => `Insert {${name}}`,
    insertionLimit: "This insertion would exceed the character limit.",
    worstCaseLength: (length) => String(length),
    picker: {
      title: "Choose a variable", noResults: "No variables found.", externalHelp: "Looks up live data from Twitch when the template runs",
      groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
      keyHints: { navigate: "select", insert: "insert", close: "close" },
    },
  },
};

const shared = {
  issueLabels: { error: "Error", warning: "Warning" },
  enabledLabel: "On",
  disabledLabel: "Off",
  messageEnabledLabel: "Send message",
  warningLabel: () => "",
};

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    ...shared,
    templateMessages: templateMessages.de,
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    enabledLabel: "An",
    disabledLabel: "Aus",
    messageEnabledLabel: "Nachricht senden",
    warningLabel: () => "Hinweis",
    title: "BELABOX", ariaLabel: "BELABOX-Einstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern.",
    saveLabel: "Speichern", discardLabel: "Verwerfen", savedLabel: "Einstellungen gespeichert.",
    pendingLabel: "Wird gespeichert …", invalidMessage: "Bitte korrigiere die markierten Felder.", numberMissing: "Zahl eingeben.",
    saveError: "Die Abrufeinstellungen konnten nicht gespeichert werden.",
    urlSaveError: "Die Statistik-URL konnte nicht gespeichert werden.",
    conflictMessage: "Die Abrufeinstellungen wurden inzwischen geändert.", reloadLabel: "Serverstand laden",
    sections: { polling: "Abruf", alerts: "Alarme" },
    fields: {
      mode: { label: "Modus", hint: "Im Intervallmodus werden Live-Daten im Hintergrund abgerufen.", options: {
        interval: { label: "Intervall", description: "Während eines Streams automatisch abrufen." },
        on_demand: { label: "Bei Bedarf", description: "Nur abrufen, wenn Daten angefordert werden." },
      } },
      intervalSeconds: { label: "Intervall", hint: "Abrufabstand nach der BELABOX-Erkennung.", options: {
        "5": { label: "5 s" }, "15": { label: "15 s" }, "30": { label: "30 s" }, "60": { label: "60 s" },
      } },
      alertsEnabled: { label: "Alarme aktiv", hint: "Bitrateneinbruch und Encoder-Abbruch im Panel melden.", description: "BELABOX-Alarme aktivieren." },
      lowBitrateKbps: { label: "Niedrige Bitrate", hint: "Alarm, wenn dieser Wert mindestens für die Haltezeit unterschritten wird.", unit: "kbps" },
      recoverBitrateKbps: { label: "Erholungsbitrate", hint: "Die Erholungsschwelle muss über der niedrigen Bitrate liegen.", unit: "kbps", invalidError: "Muss über der niedrigen Bitrate liegen." },
      holdSeconds: { label: "Haltezeit", hint: "Zeit unter der Schwelle bis zum Alarm.", unit: "s", invalidError: "Muss mindestens dem Abrufintervall entsprechen." },
      recoverHoldSeconds: { label: "Erholungszeit", hint: "Zeit über der Erholungsschwelle bis zur Entwarnung.", unit: "s", invalidError: "Muss mindestens dem Abrufintervall entsprechen." },
      chatEnabled: { label: "Chatmeldungen", hint: "Alarme und Entwarnung zusätzlich im Chat senden.", description: "BELABOX-Meldungen im Chat aktivieren." },
      chatCooldownSeconds: { label: "Chat-Abkühlzeit", hint: "Mindestabstand zwischen Alarmmeldungen.", unit: "s" },
      lowText: { label: "Bitratentext", hint: "Vorlage für einen anhaltenden Bitrateneinbruch.", requiredError: "Text fehlt", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      lowTarget: { label: "Ziel der Bitratemeldung", hint: "Wo die automatische Meldung erscheinen soll.", options: { source_only: { label: "Nur unser Chat" }, all_chats: { label: "Alle Chats" } } },
      disconnectText: { label: "Verbindungstext", hint: "Vorlage bei getrenntem Encoder.", requiredError: "Text fehlt", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      disconnectTarget: { label: "Ziel der Verbindungsmeldung", hint: "Wo die automatische Meldung erscheinen soll.", options: { source_only: { label: "Nur unser Chat" }, all_chats: { label: "Alle Chats" } } },
      recoveryText: { label: "Entwarnungstext", hint: "Vorlage, wenn die Erholung lange genug anhält.", requiredError: "Text fehlt", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      recoveryTarget: { label: "Ziel der Entwarnung", hint: "Wo die automatische Meldung erscheinen soll.", options: { source_only: { label: "Nur unser Chat" }, all_chats: { label: "Alle Chats" } } },
    },
  },
  en: {
    ...shared,
    templateMessages: templateMessages.en,
    warningLabel: () => "Warning",
    title: "BELABOX", ariaLabel: "BELABOX settings",
    readOnlyReason: "Only broadcasters and managers may change these settings.",
    saveLabel: "Save", discardLabel: "Discard", savedLabel: "Settings saved.",
    pendingLabel: "Saving …", invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number.",
    saveError: "Polling settings could not be saved.",
    urlSaveError: "The stats URL could not be saved.",
    conflictMessage: "Polling settings have changed since they were loaded.", reloadLabel: "Load server version",
    sections: { polling: "Polling", alerts: "Alerts" },
    fields: {
      mode: { label: "Mode", hint: "Interval mode fetches live data in the background.", options: {
        interval: { label: "Interval", description: "Fetch automatically while the stream is live." },
        on_demand: { label: "On demand", description: "Fetch only when data is requested." },
      } },
      intervalSeconds: { label: "Interval", hint: "Polling interval after BELABOX detection.", options: {
        "5": { label: "5 s" }, "15": { label: "15 s" }, "30": { label: "30 s" }, "60": { label: "60 s" },
      } },
      alertsEnabled: { label: "Alerts enabled", hint: "Show low bitrate and encoder disconnect notices in the panel.", description: "Enable BELABOX alerts." },
      lowBitrateKbps: { label: "Low bitrate", hint: "Alert when the bitrate remains below this value for the hold time.", unit: "kbps" },
      recoverBitrateKbps: { label: "Recovery bitrate", hint: "The recovery threshold must be above the low bitrate.", unit: "kbps", invalidError: "Must be above the low bitrate." },
      holdSeconds: { label: "Hold time", hint: "Time below the threshold before alerting.", unit: "s", invalidError: "Must be at least the polling interval." },
      recoverHoldSeconds: { label: "Recovery time", hint: "Time above the recovery threshold before clearing the alert.", unit: "s", invalidError: "Must be at least the polling interval." },
      chatEnabled: { label: "Chat messages", hint: "Also send alerts and recovery messages to chat.", description: "Enable BELABOX chat messages." },
      chatCooldownSeconds: { label: "Chat cooldown", hint: "Minimum delay between alert messages.", unit: "s" },
      lowText: { label: "Low bitrate text", hint: "Template for a sustained low bitrate.", requiredError: "Text missing", previewLabel: "Preview", previewSpeaker: "Bot" },
      lowTarget: { label: "Low bitrate target", hint: "Where the automatic message should appear.", options: { source_only: { label: "Our chat only" }, all_chats: { label: "All chats" } } },
      disconnectText: { label: "Disconnect text", hint: "Template for a disconnected encoder.", requiredError: "Text missing", previewLabel: "Preview", previewSpeaker: "Bot" },
      disconnectTarget: { label: "Disconnect target", hint: "Where the automatic message should appear.", options: { source_only: { label: "Our chat only" }, all_chats: { label: "All chats" } } },
      recoveryText: { label: "Recovery text", hint: "Template when recovery has lasted long enough.", requiredError: "Text missing", previewLabel: "Preview", previewSpeaker: "Bot" },
      recoveryTarget: { label: "Recovery target", hint: "Where the automatic message should appear.", options: { source_only: { label: "Our chat only" }, all_chats: { label: "All chats" } } },
    },
  },
};

export const belaboxSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
