import type { DashboardLanguage, LocaleCatalog } from "../../../dashboard/locale";
import type { SettingsEditorCatalog } from "../../../dashboard/ui";

const templateMessages = {
  countLabel: (count: number, maximum: number) => `${String(count)} / ${String(maximum)}`,
  previewCountLabel: (count: number) => String(count),
  unknownVariable: (name: string) => name,
  insertSuggestionLabel: (name: string) => name,
  worstCaseLength: (length: number) => String(length),
  variablePicker: {
    triggerLabel: "", title: "", searchLabel: "", closeLabel: "", noResults: "", createVariableLabel: "",
    externalHelp: "", groupLabels: { context: "", stream: "", person: "", command: "", time_random: "", event: "", channel: "", text_blocks: "" },
    textBlockSample: "", keyHints: { navigate: "", insert: "", close: "" },
  },
};

const shared = {
  issueLabels: { error: "Error", warning: "Warning" },
  enabledLabel: "On",
  disabledLabel: "Off",
  templateMessages,
  warningLabel: () => "",
};

const catalog: LocaleCatalog<SettingsEditorCatalog> = {
  de: {
    ...shared,
    issueLabels: { error: "Fehler", warning: "Hinweis" },
    enabledLabel: "An",
    disabledLabel: "Aus",
    warningLabel: () => "Hinweis",
    title: "BELABOX-Abruf", ariaLabel: "BELABOX-Abrufeinstellungen",
    readOnlyReason: "Nur Broadcaster und Verwalter dürfen diese Einstellungen ändern.",
    saveLabel: "Abrufeinstellungen speichern", discardLabel: "Verwerfen", savedLabel: "Abrufeinstellungen gespeichert.",
    pendingLabel: "Wird gespeichert …", invalidMessage: "Bitte korrigiere die markierten Felder.", numberMissing: "Zahl eingeben.",
    loadError: "Die Abrufeinstellungen konnten nicht geladen werden.", saveError: "Die Abrufeinstellungen konnten nicht gespeichert werden.",
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
      alertsEnabled: { label: "Alarme", hint: "Bitrateneinbruch und Encoder-Abbruch im Panel melden.", description: "BELABOX-Alarme aktivieren." },
      lowBitrateKbps: { label: "Niedrige Bitrate", hint: "Alarm, wenn dieser Wert mindestens für die Haltezeit unterschritten wird.", unit: "kbps" },
      recoverBitrateKbps: { label: "Erholungsbitrate", hint: "Die Erholungsschwelle muss über der niedrigen Bitrate liegen.", unit: "kbps", invalidError: "Muss über der niedrigen Bitrate liegen." },
      holdSeconds: { label: "Haltezeit", hint: "Zeit unter der Schwelle bis zum Alarm.", unit: "s", invalidError: "Muss mindestens dem Abrufintervall entsprechen." },
      recoverHoldSeconds: { label: "Erholungszeit", hint: "Zeit über der Erholungsschwelle bis zur Entwarnung.", unit: "s", invalidError: "Muss mindestens dem Abrufintervall entsprechen." },
      chatEnabled: { label: "Chatmeldungen", hint: "Alarme und Entwarnung zusätzlich im Chat senden.", description: "BELABOX-Meldungen im Chat aktivieren." },
      chatCooldownSeconds: { label: "Chat-Abkühlzeit", hint: "Mindestabstand zwischen Alarmmeldungen.", unit: "s" },
      lowText: { label: "Bitratentext", hint: "Vorlage für einen anhaltenden Bitrateneinbruch.", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      lowTarget: { label: "Ziel der Bitratemeldung", hint: "Wo die automatische Meldung erscheinen soll." },
      disconnectText: { label: "Verbindungstext", hint: "Vorlage bei getrenntem Encoder.", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      disconnectTarget: { label: "Ziel der Verbindungsmeldung", hint: "Wo die automatische Meldung erscheinen soll." },
      recoveryText: { label: "Entwarnungstext", hint: "Vorlage, wenn die Erholung lange genug anhält.", previewLabel: "Vorschau", previewSpeaker: "Bot" },
      recoveryTarget: { label: "Ziel der Entwarnung", hint: "Wo die automatische Meldung erscheinen soll." },
    },
  },
  en: {
    ...shared,
    warningLabel: () => "Warning",
    title: "BELABOX polling", ariaLabel: "BELABOX polling settings",
    readOnlyReason: "Only broadcasters and managers may change these settings.",
    saveLabel: "Save polling settings", discardLabel: "Discard", savedLabel: "Polling settings saved.",
    pendingLabel: "Saving …", invalidMessage: "Please correct the marked fields.", numberMissing: "Enter a number.",
    loadError: "Polling settings could not be loaded.", saveError: "Polling settings could not be saved.",
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
      alertsEnabled: { label: "Alerts", hint: "Show low bitrate and encoder disconnect notices in the panel.", description: "Enable BELABOX alerts." },
      lowBitrateKbps: { label: "Low bitrate", hint: "Alert when the bitrate remains below this value for the hold time.", unit: "kbps" },
      recoverBitrateKbps: { label: "Recovery bitrate", hint: "The recovery threshold must be above the low bitrate.", unit: "kbps", invalidError: "Must be above the low bitrate." },
      holdSeconds: { label: "Hold time", hint: "Time below the threshold before alerting.", unit: "s", invalidError: "Must be at least the polling interval." },
      recoverHoldSeconds: { label: "Recovery time", hint: "Time above the recovery threshold before clearing the alert.", unit: "s", invalidError: "Must be at least the polling interval." },
      chatEnabled: { label: "Chat messages", hint: "Also send alerts and recovery messages to chat.", description: "Enable BELABOX chat messages." },
      chatCooldownSeconds: { label: "Chat cooldown", hint: "Minimum delay between alert messages.", unit: "s" },
      lowText: { label: "Low bitrate text", hint: "Template for a sustained low bitrate.", previewLabel: "Preview", previewSpeaker: "Bot" },
      lowTarget: { label: "Low bitrate target", hint: "Where the automatic message should appear." },
      disconnectText: { label: "Disconnect text", hint: "Template for a disconnected encoder.", previewLabel: "Preview", previewSpeaker: "Bot" },
      disconnectTarget: { label: "Disconnect target", hint: "Where the automatic message should appear." },
      recoveryText: { label: "Recovery text", hint: "Template when recovery has lasted long enough.", previewLabel: "Preview", previewSpeaker: "Bot" },
      recoveryTarget: { label: "Recovery target", hint: "Where the automatic message should appear." },
    },
  },
};

export const belaboxSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
