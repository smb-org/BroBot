export interface ChannelSettingsTexts {
  section: string;
  timeZone: string;
  timeZoneHint: string;
  save: string;
  readOnly: string;
  loadError: string;
  saveError: string;
  invalid: string;
}

const texts: Readonly<Record<"de" | "en", ChannelSettingsTexts>> = {
  de: {
    section: "Kanaleinstellungen",
    timeZone: "Kanalzeitzone",
    timeZoneHint: "Gültige IANA-Zeitzone. Sie wird für Datum, Uhrzeit und zeitabhängige Textbausteine verwendet.",
    save: "Zeitzone speichern",
    readOnly: "Nur Broadcaster und Verwalter dürfen diese Einstellung ändern.",
    loadError: "Die Kanaleinstellungen konnten nicht geladen werden.",
    saveError: "Die Zeitzone konnte nicht gespeichert werden.",
    invalid: "Bitte eine gültige IANA-Zeitzone eingeben.",
  },
  en: {
    section: "Channel settings",
    timeZone: "Channel time zone",
    timeZoneHint: "A valid IANA time zone used for date, time, and time based text block conditions.",
    save: "Save time zone",
    readOnly: "Only broadcasters and managers can change this setting.",
    loadError: "Channel settings could not be loaded.",
    saveError: "The time zone could not be saved.",
    invalid: "Enter a valid IANA time zone.",
  },
};

export const channelSettingsTexts = (language: "de" | "en"): ChannelSettingsTexts => texts[language];
