import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface WerbungPanelTexte {
  titel: string;
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
