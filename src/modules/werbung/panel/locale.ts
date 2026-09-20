import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog } from "../../../dashboard/locale";

interface WerbungPanelTexte {
  titel: string;
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
    automatisch: "Automatische Werbepause",
    manuell: "Manuell gestartete Werbepause",
    platzhalter: "{dauer} wird durch die Dauer in Sekunden ersetzt.",
    speichern: "Ansagen speichern",
    gespeichert: "Ansagen gespeichert.",
    laden: "Werbeeinstellungen werden geladen …",
    fehler: "Die Werbeeinstellungen konnten nicht geladen oder gespeichert werden.",
  },
  en: {
    titel: "Announcements",
    automatisch: "Automatic ad break",
    manuell: "Manually started ad break",
    platzhalter: "{dauer} is replaced with the duration in seconds.",
    speichern: "Save announcements",
    gespeichert: "Announcements saved.",
    laden: "Loading ad break settings …",
    fehler: "The ad break settings could not be loaded or saved.",
  },
};

export const werbungPanelTexte = (
  language: DashboardLanguage = dashboardLanguage(),
): WerbungPanelTexte => texte[language];
