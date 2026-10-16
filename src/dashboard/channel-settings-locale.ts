export interface ChannelSettingsTexts {
  section: string;
  pageTitle: string;
  pageDescription: string;
  timeZone: string;
  timeZoneHint: string;
  timeZoneSection: string;
  locationMissing: string;
  locationMissingWarning: string;
  readOnly: string;
  loadError: string;
  saveError: string;
  settingsConflict: string;
  invalid: string;
  location: string;
  locationHint: string;
  locationSearch: string;
  locationSearchButton: string;
  locationSearching: string;
  locationSelect: string;
  locationResults: string;
  locationNoResults: string;
  locationAttribution: string;
  locationChange: string;
  locationRemove: string;
  locationRemoveTitle: string;
  locationRemoveDescription: string;
  cancel: string;
  locationSaveFailed: string;
  locationSearchFailed: string;
  locationTimeZoneSuggestion: (timeZone: string) => string;
  locationTimeZoneAction: string;
  defaultChatTarget: string;
  defaultChatTargetHint: string;
}

const texts: Readonly<Record<"de" | "en", ChannelSettingsTexts>> = {
  de: {
    section: "Kanaleinstellungen",
    pageTitle: "Ort & Wetter",
    pageDescription: "Standort für Wetter, Sonnenzeiten und Mondphase",
    timeZone: "Kanalzeitzone",
    timeZoneHint: "Gültige IANA-Zeitzone. Sie wird für Datum, Uhrzeit und zeitabhängige Textbausteine verwendet.",
    timeZoneSection: "Zeitzone",
    locationMissing: "Standort fehlt",
    locationMissingWarning: "Wetter, Sonnenzeiten und Mondphase benötigen einen Kanalstandort.",
    readOnly: "Nur Broadcaster und Verwalter dürfen diese Einstellung ändern.",
    loadError: "Die Kanaleinstellungen konnten nicht geladen werden.",
    saveError: "Die Zeitzone konnte nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    invalid: "Bitte eine gültige IANA-Zeitzone eingeben.",
    location: "Standort",
    locationHint: "Gilt für Wetter, Sonnenzeiten und Mondphase. Änderungen mit Speichern übernehmen.",
    locationSearch: "Ort suchen",
    locationSearchButton: "Suchen",
    locationSearching: "Orte werden gesucht …",
    locationSelect: "Auswählen",
    locationResults: "Standortsuche",
    locationNoResults: "Keine passenden Orte gefunden.",
    locationAttribution: "Ortssuche von Open-Meteo.com",
    locationChange: "Standort ändern",
    locationRemove: "Standort entfernen",
    locationRemoveTitle: "Standort entfernen?",
    locationRemoveDescription: "Der Standort wird nach dem Speichern aus den Kanaleinstellungen entfernt.",
    cancel: "Abbrechen",
    locationSaveFailed: "Der Standort konnte nicht gespeichert werden.",
    locationSearchFailed: "Orte konnten nicht gesucht werden.",
    locationTimeZoneSuggestion: (timeZone) => `Kanalzeitzone auf ${timeZone} setzen?`,
    locationTimeZoneAction: "Zeitzone übernehmen",
    defaultChatTarget: "Standard-Chat-Ziel",
    defaultChatTargetHint: "Wird für Einträge verwendet, die kein eigenes Chat-Ziel festlegen.",
  },
  en: {
    section: "Channel settings",
    pageTitle: "Location & weather",
    pageDescription: "Location for weather, sunrise, sunset, and moon phase",
    timeZone: "Channel time zone",
    timeZoneHint: "A valid IANA time zone used for date, time, and time based text block conditions.",
    timeZoneSection: "Time zone",
    locationMissing: "Location missing",
    locationMissingWarning: "Weather, sunrise and moon phase need a channel location.",
    readOnly: "Only broadcasters and managers can change this setting.",
    loadError: "Channel settings could not be loaded.",
    saveError: "The time zone could not be saved.",
    settingsConflict: "Settings changed in another session. Reload before saving.",
    invalid: "Enter a valid IANA time zone.",
    location: "Location",
    locationHint: "Used for weather, sunrise, sunset, and moon phase. Save to apply your change.",
    locationSearch: "Search for a place",
    locationSearchButton: "Search",
    locationSearching: "Searching locations …",
    locationSelect: "Select",
    locationResults: "Location search results",
    locationNoResults: "No matching locations found.",
    locationAttribution: "Location search by Open-Meteo.com",
    locationChange: "Change location",
    locationRemove: "Remove location",
    locationRemoveTitle: "Remove location?",
    locationRemoveDescription: "The location will be removed from channel settings when you save.",
    cancel: "Cancel",
    locationSaveFailed: "Location could not be saved.",
    locationSearchFailed: "Locations could not be searched.",
    locationTimeZoneSuggestion: (timeZone) => `Set channel time zone to ${timeZone}?`,
    locationTimeZoneAction: "Apply time zone",
    defaultChatTarget: "Default chat target",
    defaultChatTargetHint: "Used by entries that do not set their own chat target.",
  },
};

export const channelSettingsTexts = (language: "de" | "en"): ChannelSettingsTexts => texts[language];
