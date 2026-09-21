import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface WerbungPanelTexte {
  titel: string;
  zeitplanAbschnitt: string;
  keineWerbung: string;
  naechsteWerbung: string;
  dauer: string;
  vorwarnungAbschnitt: string;
  vorwarnungAktiv: string;
  vorlaufSekunden: string;
  vorwarnungText: string;
  platzhalterVorwarnung: string;
  snoozeAbschnitt: string;
  snoozeButton: (anzahl: string, aufladung: string) => string;
  snoozeScopeFehlt: string;
  snoozeKeine: string;
  snoozeUnbekannt: string;
  letzteAbschnitt: string;
  keineLetzte: string;
  letzteDauer: (dauer: string) => string;
  letzteZeit: (zeitpunkt: string) => string;
  automatischAbschnitt: string;
  manuellAbschnitt: string;
  aktionen: string;
  automatisch: string;
  manuell: string;
  platzhalter: string;
  speichern: string;
  gespeichert: string;
  laden: string;
  fehler: string;
}

const texte: LocaleCatalog<WerbungPanelTexte> = {
  de: {
    titel: "Ansagen",
    zeitplanAbschnitt: "Nächste Werbung",
    keineWerbung: "Derzeit ist keine Werbung geplant.",
    naechsteWerbung: "Zeitpunkt",
    dauer: "Dauer",
    vorwarnungAbschnitt: "Vorwarnung",
    vorwarnungAktiv: "Vorwarnung vor der Werbung",
    vorlaufSekunden: "Vorlaufzeit (Sekunden)",
    vorwarnungText: "Vorwarnungstext",
    platzhalterVorwarnung: "{seconds} bleibt als englischer Platzhalter und wird durch die verbleibenden Sekunden ersetzt.",
    snoozeAbschnitt: "Snooze",
    snoozeButton: (anzahl, aufladung) => `Snooze · ${anzahl} verfügbar · Aufladung ${aufladung}`,
    snoozeScopeFehlt: "Snooze ist deaktiviert: channel:manage:ads fehlt.",
    snoozeKeine: "Snooze ist deaktiviert: keine Verschiebung mehr verfügbar.",
    snoozeUnbekannt: "Snooze ist deaktiviert: der Twitch-Zähler ist nicht verfügbar.",
    letzteAbschnitt: "Letzte Werbepausen",
    keineLetzte: "Noch keine Werbepausen im Ereignisprotokoll.",
    letzteDauer: (dauer) => `${dauer} Sekunden`,
    letzteZeit: (zeitpunkt) => zeitpunkt,
    automatischAbschnitt: "Automatische Ansage",
    manuellAbschnitt: "Manuelle Ansage",
    aktionen: "Aktionen",
    automatisch: "Automatische Werbepause",
    manuell: "Manuell gestartete Werbepause",
    platzhalter: "{duration} wird durch die Dauer in Sekunden ersetzt.",
    speichern: "Ansagen speichern",
    gespeichert: "Ansagen gespeichert.",
    laden: "Werbeeinstellungen werden geladen …",
    fehler: "Die Werbeeinstellungen konnten nicht geladen oder gespeichert werden.",
  },
  en: {
    titel: "Announcements",
    zeitplanAbschnitt: "Next ad break",
    keineWerbung: "No ad break is currently scheduled.",
    naechsteWerbung: "Time",
    dauer: "Duration",
    vorwarnungAbschnitt: "Warning",
    vorwarnungAktiv: "Warn before the ad break",
    vorlaufSekunden: "Lead time (seconds)",
    vorwarnungText: "Warning text",
    platzhalterVorwarnung: "{seconds} stays as the English placeholder and is replaced with the remaining seconds.",
    snoozeAbschnitt: "Snooze",
    snoozeButton: (anzahl, aufladung) => `Snooze · ${anzahl} available · refresh ${aufladung}`,
    snoozeScopeFehlt: "Snooze is disabled: channel:manage:ads is missing.",
    snoozeKeine: "Snooze is disabled: no postponements remain.",
    snoozeUnbekannt: "Snooze is disabled: Twitch did not provide a counter.",
    letzteAbschnitt: "Recent ad breaks",
    keineLetzte: "No ad breaks are in the event log yet.",
    letzteDauer: (dauer) => `${dauer} seconds`,
    letzteZeit: (zeitpunkt) => zeitpunkt,
    automatischAbschnitt: "Automatic announcement",
    manuellAbschnitt: "Manual announcement",
    aktionen: "Actions",
    automatisch: "Automatic ad break",
    manuell: "Manually started ad break",
    platzhalter: "{duration} is replaced with the duration in seconds.",
    speichern: "Save announcements",
    gespeichert: "Announcements saved.",
    laden: "Loading ad break settings …",
    fehler: "The ad break settings could not be loaded or saved.",
  },
};

export const werbungPanelTexte = (
  language: DashboardLanguage = dashboardLanguage(),
): WerbungPanelTexte => texte[language];
