import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface AdsPanelTexts {
  title: string;
  scheduleSection: string;
  noAdBreak: string;
  scheduledTime: string;
  duration: string;
  warningSection: string;
  warningEnabled: string;
  leadSeconds: string;
  prewarningText: string;
  warningPlaceholderHint: string;
  snoozeSection: string;
  snoozeButton: (count: string, refresh: string) => string;
  snoozeScopeMissing: string;
  snoozeNone: string;
  snoozeUnknown: string;
  recentSection: string;
  noRecent: string;
  recentDuration: (duration: string) => string;
  recentTime: (timestamp: string) => string;
  automaticSection: string;
  manualSection: string;
  actions: string;
  automatic: string;
  manual: string;
  durationPlaceholderHint: string;
  save: string;
  saved: string;
  load: string;
  error: string;
  numberMissing: string;
}

const texts: LocaleCatalog<AdsPanelTexts> = {
  de: {
    title: "Ansagen",
    scheduleSection: "Nächste Werbung",
    noAdBreak: "Derzeit ist keine Werbung geplant.",
    scheduledTime: "Zeitpunkt",
    duration: "Dauer",
    warningSection: "Vorwarnung",
    warningEnabled: "Vorwarnung vor der Werbung",
    leadSeconds: "Vorlaufzeit (Sekunden)",
    prewarningText: "Vorwarnungstext",
    warningPlaceholderHint: "{seconds} bleibt als englischer Platzhalter und wird durch die verbleibenden Sekunden ersetzt.",
    snoozeSection: "Snooze",
    snoozeButton: (count, refresh) => `Snooze · ${count} verfügbar · Aufladung ${refresh}`,
    snoozeScopeMissing: "Snooze ist deaktiviert: channel:manage:ads fehlt.",
    snoozeNone: "Snooze ist deaktiviert: keine Verschiebung mehr verfügbar.",
    snoozeUnknown: "Snooze ist deaktiviert: der Twitch-Zähler ist nicht verfügbar.",
    recentSection: "Letzte Werbepausen",
    noRecent: "Noch keine Werbepausen im Ereignisprotokoll.",
    recentDuration: (duration) => `${duration} Sekunden`,
    recentTime: (timestamp) => timestamp,
    automaticSection: "Automatische Ansage",
    manualSection: "Manuelle Ansage",
    actions: "Aktionen",
    automatic: "Automatische Werbepause",
    manual: "Manuell gestartete Werbepause",
    durationPlaceholderHint: "{duration} wird durch die Dauer in Sekunden ersetzt.",
    save: "Ansagen speichern",
    saved: "Ansagen gespeichert.",
    load: "Werbeeinstellungen werden geladen …",
    error: "Die Werbeeinstellungen konnten nicht geladen oder gespeichert werden.",
    numberMissing: "Zahl eingeben",
  },
  en: {
    title: "Announcements",
    scheduleSection: "Next ad break",
    noAdBreak: "No ad break is currently scheduled.",
    scheduledTime: "Time",
    duration: "Duration",
    warningSection: "Warning",
    warningEnabled: "Warn before the ad break",
    leadSeconds: "Lead time (seconds)",
    prewarningText: "Warning text",
    warningPlaceholderHint: "{seconds} stays as the English placeholder and is replaced with the remaining seconds.",
    snoozeSection: "Snooze",
    snoozeButton: (count, refresh) => `Snooze · ${count} available · refresh ${refresh}`,
    snoozeScopeMissing: "Snooze is disabled: channel:manage:ads is missing.",
    snoozeNone: "Snooze is disabled: no postponements remain.",
    snoozeUnknown: "Snooze is disabled: Twitch did not provide a counter.",
    recentSection: "Recent ad breaks",
    noRecent: "No ad breaks are in the event log yet.",
    recentDuration: (duration) => `${duration} seconds`,
    recentTime: (timestamp) => timestamp,
    automaticSection: "Automatic announcement",
    manualSection: "Manual announcement",
    actions: "Actions",
    automatic: "Automatic ad break",
    manual: "Manually started ad break",
    durationPlaceholderHint: "{duration} is replaced with the duration in seconds.",
    save: "Save announcements",
    saved: "Announcements saved.",
    load: "Loading ad break settings …",
    error: "The ad break settings could not be loaded or saved.",
    numberMissing: "Enter a number",
  },
};

export const adsPanelTexts = (
  language: DashboardLanguage = dashboardLanguage(),
): AdsPanelTexts => texts[language];
