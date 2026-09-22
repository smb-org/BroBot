import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";

export interface RaidPanelTexts {
  title: string;
  thresholdSection: string;
  shoutoutEnabled: string;
  shoutoutThreshold: string;
  textThreshold: string;
  toggleLabel: (active: boolean) => string;
  fullText: string;
  shortText: string;
  placeholderFull: string;
  placeholderShort: string;
  actions: string;
  save: string;
  discard: string;
  saving: string;
  saved: string;
  load: string;
  error: string;
  numberMissing: string;
  managementLocked: string;
}

const catalog: Record<DashboardLanguage, RaidPanelTexts> = {
  de: {
    title: "Raid-Shoutout",
    thresholdSection: "Shoutout und Nachrichten",
    shoutoutEnabled: "Helix-Shoutout automatisch senden",
    shoutoutThreshold: "Shoutout-Schwelle (Zuschauer)",
    textThreshold: "Text-Schwelle (Zuschauer)",
    toggleLabel: (active) => `Helix-Shoutout automatisch senden: ${active ? "eingeschaltet" : "ausgeschaltet"}`,
    fullText: "Voller Raid-Text",
    shortText: "Kurzer Dankestext",
    placeholderFull: "{channel} und {viewers} werden beim Eingang ersetzt.",
    placeholderShort: "{channel} und {viewers} werden beim Eingang ersetzt.",
    actions: "Aktionen",
    save: "Raid-Einstellungen speichern",
    discard: "Verwerfen",
    saving: "Wird gespeichert …",
    saved: "Raid-Einstellungen gespeichert.",
    load: "Raid-Einstellungen werden geladen …",
    error: "Die Raid-Einstellungen konnten nicht geladen oder gespeichert werden.",
    numberMissing: "Zahl eingeben",
    managementLocked: "Nur Broadcaster und Verwalter dürfen Raid-Einstellungen ändern.",
  },
  en: {
    title: "Raid shoutout",
    thresholdSection: "Shoutout and messages",
    shoutoutEnabled: "Send automatic Helix shoutouts",
    shoutoutThreshold: "Shoutout threshold (viewers)",
    textThreshold: "Text threshold (viewers)",
    toggleLabel: (active) => `Automatic Helix shoutout: ${active ? "enabled" : "disabled"}`,
    fullText: "Full raid message",
    shortText: "Small raid message",
    placeholderFull: "{channel} and {viewers} are replaced when the raid arrives.",
    placeholderShort: "{channel} and {viewers} are replaced when the raid arrives.",
    actions: "Actions",
    save: "Save raid settings",
    discard: "Discard",
    saving: "Saving …",
    saved: "Raid settings saved.",
    load: "Loading raid settings …",
    error: "The raid settings could not be loaded or saved.",
    numberMissing: "Enter a number",
    managementLocked: "Only broadcasters and managers may change raid settings.",
  },
};

export const raidPanelTexts = (language: DashboardLanguage = dashboardLanguage()): RaidPanelTexts => catalog[language];
