import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface AdsPanelTexts {
  titel: string;
  scheduleSection: string;
  keineWerbung: string;
  naechsteWerbung: string;
  duration: string;
  vorwarnungAbschnitt: string;
  vorwarnungAktiv: string;
  leadSeconds: string;
  prewarningText: string;
  platzhalterVorwarnung: string;
  snoozeAbschnitt: string;
  snoozeButton: (count: string, aufladung: string) => string;
  snoozeScopeFehlt: string;
  snoozeKeine: string;
  snoozeUnbekannt: string;
  letzteAbschnitt: string;
  keineLetzte: string;
  letzteDauer: (dauer: string) => string;
  letzteZeit: (timestamp: string) => string;
  automatischAbschnitt: string;
  manuellAbschnitt: string;
  aktionen: string;
  automatic: string;
  manual: string;
  platzhalter: string;
  save: string;
  gespeichert: string;
  load: string;
  fehler: string;
  zahlFehlt: string;
}

const texts: LocaleCatalog<AdsPanelTexts> = {
  de: {
    titel: "Ansagen",
    scheduleSection: "Nächste Werbung",
    keineWerbung: "Derzeit ist keine Werbung geplant.",
    naechsteWerbung: "Zeitpunkt",
    duration: "Dauer",
    vorwarnungAbschnitt: "Vorwarnung",
    vorwarnungAktiv: "Vorwarnung vor der Werbung",
    leadSeconds: "Vorlaufzeit (Sekunden)",
    prewarningText: "Vorwarnungstext",
    platzhalterVorwarnung: "{seconds} bleibt als englischer Platzhalter und wird durch die verbleibenden Sekunden ersetzt.",
    snoozeAbschnitt: "Snooze",
    snoozeButton: (count, aufladung) => `Snooze · ${count} verfügbar · Aufladung ${aufladung}`,
    snoozeScopeFehlt: "Snooze ist deaktiviert: channel:manage:ads fehlt.",
    snoozeKeine: "Snooze ist deaktiviert: keine Verschiebung mehr verfügbar.",
    snoozeUnbekannt: "Snooze ist deaktiviert: der Twitch-Zähler ist nicht verfügbar.",
    letzteAbschnitt: "Letzte Werbepausen",
    keineLetzte: "Noch keine Werbepausen im Ereignisprotokoll.",
    letzteDauer: (dauer) => `${dauer} Sekunden`,
    letzteZeit: (timestamp) => timestamp,
    automatischAbschnitt: "Automatische Ansage",
    manuellAbschnitt: "Manuelle Ansage",
    aktionen: "Aktionen",
    automatic: "Automatische Werbepause",
    manual: "Manuell gestartete Werbepause",
    platzhalter: "{duration} wird durch die Dauer in Sekunden ersetzt.",
    save: "Ansagen speichern",
    gespeichert: "Ansagen gespeichert.",
    load: "Werbeeinstellungen werden geladen …",
    fehler: "Die Werbeeinstellungen konnten nicht geladen oder gespeichert werden.",
    zahlFehlt: "Zahl eingeben",
  },
  en: {
    titel: "Announcements",
    scheduleSection: "Next ad break",
    keineWerbung: "No ad break is currently scheduled.",
    naechsteWerbung: "Time",
    duration: "Duration",
    vorwarnungAbschnitt: "Warning",
    vorwarnungAktiv: "Warn before the ad break",
    leadSeconds: "Lead time (seconds)",
    prewarningText: "Warning text",
    platzhalterVorwarnung: "{seconds} stays as the English placeholder and is replaced with the remaining seconds.",
    snoozeAbschnitt: "Snooze",
    snoozeButton: (count, aufladung) => `Snooze · ${count} available · refresh ${aufladung}`,
    snoozeScopeFehlt: "Snooze is disabled: channel:manage:ads is missing.",
    snoozeKeine: "Snooze is disabled: no postponements remain.",
    snoozeUnbekannt: "Snooze is disabled: Twitch did not provide a counter.",
    letzteAbschnitt: "Recent ad breaks",
    keineLetzte: "No ad breaks are in the event log yet.",
    letzteDauer: (dauer) => `${dauer} seconds`,
    letzteZeit: (timestamp) => timestamp,
    automatischAbschnitt: "Automatic announcement",
    manuellAbschnitt: "Manual announcement",
    aktionen: "Actions",
    automatic: "Automatic ad break",
    manual: "Manually started ad break",
    platzhalter: "{duration} is replaced with the duration in seconds.",
    save: "Save announcements",
    gespeichert: "Announcements saved.",
    load: "Loading ad break settings …",
    fehler: "The ad break settings could not be loaded or saved.",
    zahlFehlt: "Enter a number",
  },
};

export const adsPanelTexts = (
  language: DashboardLanguage = dashboardLanguage(),
): AdsPanelTexts => texts[language];
