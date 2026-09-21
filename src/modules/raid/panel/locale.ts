import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";

export interface RaidPanelTexte {
  titel: string;
  schwelleAbschnitt: string;
  mindestZuschauer: string;
  vollerText: string;
  kurzerText: string;
  platzhalterVoll: string;
  platzhalterKlein: string;
  aktionen: string;
  speichern: string;
  gespeichert: string;
  laden: string;
  fehler: string;
  verwaltungGesperrt: string;
}

const katalog: Record<DashboardLanguage, RaidPanelTexte> = {
  de: {
    titel: "Raid-Shoutout",
    schwelleAbschnitt: "Schwelle und Nachrichten",
    mindestZuschauer: "Mindestzuschauer",
    vollerText: "Voller Raid-Text",
    kurzerText: "Kurzer Dankestext",
    platzhalterVoll: "{kanal} und {zuschauer} werden beim Eingang ersetzt.",
    platzhalterKlein: "{kanal} und {zuschauer} werden beim Eingang ersetzt.",
    aktionen: "Aktionen",
    speichern: "Raid-Einstellungen speichern",
    gespeichert: "Raid-Einstellungen gespeichert.",
    laden: "Raid-Einstellungen werden geladen …",
    fehler: "Die Raid-Einstellungen konnten nicht geladen oder gespeichert werden.",
    verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.",
  },
  en: {
    titel: "Raid shoutout",
    schwelleAbschnitt: "Threshold and messages",
    mindestZuschauer: "Minimum viewers",
    vollerText: "Full raid message",
    kurzerText: "Small raid message",
    platzhalterVoll: "{kanal} and {zuschauer} are replaced when the raid arrives.",
    platzhalterKlein: "{kanal} and {zuschauer} are replaced when the raid arrives.",
    aktionen: "Actions",
    speichern: "Save raid settings",
    gespeichert: "Raid settings saved.",
    laden: "Loading raid settings …",
    fehler: "The raid settings could not be loaded or saved.",
    verwaltungGesperrt: "Only broadcasters and managers may change raid settings.",
  },
};

export const raidPanelTexte = (language: DashboardLanguage = dashboardLanguage()): RaidPanelTexte => katalog[language];
