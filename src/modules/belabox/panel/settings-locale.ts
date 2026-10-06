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
    sections: { polling: "Abruf" },
    fields: {
      mode: { label: "Modus", hint: "Im Intervallmodus werden Live-Daten im Hintergrund abgerufen.", options: {
        interval: { label: "Intervall", description: "Während eines Streams automatisch abrufen." },
        on_demand: { label: "Bei Bedarf", description: "Nur abrufen, wenn Daten angefordert werden." },
      } },
      intervalSeconds: { label: "Intervall", hint: "Abrufabstand nach der BELABOX-Erkennung.", options: {
        "5": { label: "5 s" }, "15": { label: "15 s" }, "30": { label: "30 s" }, "60": { label: "60 s" },
      } },
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
    sections: { polling: "Polling" },
    fields: {
      mode: { label: "Mode", hint: "Interval mode fetches live data in the background.", options: {
        interval: { label: "Interval", description: "Fetch automatically while the stream is live." },
        on_demand: { label: "On demand", description: "Fetch only when data is requested." },
      } },
      intervalSeconds: { label: "Interval", hint: "Polling interval after BELABOX detection.", options: {
        "5": { label: "5 s" }, "15": { label: "15 s" }, "30": { label: "30 s" }, "60": { label: "60 s" },
      } },
    },
  },
};

export const belaboxSettingsEditorCatalog = (language: DashboardLanguage): SettingsEditorCatalog => catalog[language];
