import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";

export interface RaidPanelTexts {
  titel: string;
  schwelleAbschnitt: string;
  shoutoutEnabled: string;
  shoutoutThreshold: string;
  textThreshold: string;
  schalter: (active: boolean) => string;
  vollerText: string;
  kurzerText: string;
  platzhalterVoll: string;
  platzhalterKlein: string;
  aktionen: string;
  speichern: string;
  gespeichert: string;
  laden: string;
  fehler: string;
  zahlFehlt: string;
  verwaltungGesperrt: string;
}

const katalog: Record<DashboardLanguage, RaidPanelTexts> = {
  de: {
    titel: "Raid-Shoutout",
    schwelleAbschnitt: "Shoutout und Nachrichten",
    shoutoutEnabled: "Helix-Shoutout automatisch senden",
    shoutoutThreshold: "Shoutout-Schwelle (Zuschauer)",
    textThreshold: "Text-Schwelle (Zuschauer)",
    schalter: (active) => `Helix-Shoutout automatisch senden: ${active ? "eingeschaltet" : "ausgeschaltet"}`,
    vollerText: "Voller Raid-Text",
    kurzerText: "Kurzer Dankestext",
    platzhalterVoll: "{channel} und {viewers} werden beim Eingang ersetzt.",
    platzhalterKlein: "{channel} und {viewers} werden beim Eingang ersetzt.",
    aktionen: "Aktionen",
    speichern: "Raid-Einstellungen speichern",
    gespeichert: "Raid-Einstellungen gespeichert.",
    laden: "Raid-Einstellungen werden geladen …",
    fehler: "Die Raid-Einstellungen konnten nicht geladen oder gespeichert werden.",
    zahlFehlt: "Zahl eingeben",
    verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.",
  },
  en: {
    titel: "Raid shoutout",
    schwelleAbschnitt: "Shoutout and messages",
    shoutoutEnabled: "Send automatic Helix shoutouts",
    shoutoutThreshold: "Shoutout threshold (viewers)",
    textThreshold: "Text threshold (viewers)",
    schalter: (active) => `Automatic Helix shoutout: ${active ? "enabled" : "disabled"}`,
    vollerText: "Full raid message",
    kurzerText: "Small raid message",
    platzhalterVoll: "{channel} and {viewers} are replaced when the raid arrives.",
    platzhalterKlein: "{channel} and {viewers} are replaced when the raid arrives.",
    aktionen: "Actions",
    speichern: "Save raid settings",
    gespeichert: "Raid settings saved.",
    laden: "Loading raid settings …",
    fehler: "The raid settings could not be loaded or saved.",
    zahlFehlt: "Enter a number",
    verwaltungGesperrt: "Only broadcasters and managers may change raid settings.",
  },
};

export const raidPanelTexts = (language: DashboardLanguage = dashboardLanguage()): RaidPanelTexts => katalog[language];
