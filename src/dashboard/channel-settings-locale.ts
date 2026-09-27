export interface ChannelSettingsTexts {
  section: string;
  timeZone: string;
  timeZoneHint: string;
  save: string;
  readOnly: string;
  loadError: string;
  saveError: string;
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
  locationNotSet: string;
  locationRemoved: string;
  cancel: string;
  locationSaved: string;
  locationSaveFailed: string;
  locationSearchFailed: string;
  locationTimeZoneSuggestion: (timeZone: string) => string;
  locationTimeZoneAction: string;
  locationTimeZoneSaved: string;
  locationTimeZoneSaveFailed: string;
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
    location: "Standort",
    locationHint: "Wird von Kanalmodulen für standortabhängige Daten verwendet.",
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
    locationRemoveDescription: "Der gespeicherte Standort wird dauerhaft aus den Kanaleinstellungen entfernt.",
    locationNotSet: "Es ist kein Standort zum Entfernen gespeichert.",
    locationRemoved: "Der Standort wurde entfernt.",
    cancel: "Abbrechen",
    locationSaved: "Der Standort wurde gespeichert.",
    locationSaveFailed: "Der Standort konnte nicht gespeichert werden.",
    locationSearchFailed: "Orte konnten nicht gesucht werden.",
    locationTimeZoneSuggestion: (timeZone) => `Kanalzeitzone auf ${timeZone} setzen?`,
    locationTimeZoneAction: "Zeitzone übernehmen",
    locationTimeZoneSaved: "Die Kanalzeitzone wurde aktualisiert.",
    locationTimeZoneSaveFailed: "Die Kanalzeitzone konnte nicht aktualisiert werden.",
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
    location: "Location",
    locationHint: "Used by channel modules for location based data.",
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
    locationRemoveDescription: "The saved location will be permanently removed from channel settings.",
    locationNotSet: "There is no saved location to remove.",
    locationRemoved: "Location removed.",
    cancel: "Cancel",
    locationSaved: "Location saved.",
    locationSaveFailed: "Location could not be saved.",
    locationSearchFailed: "Locations could not be searched.",
    locationTimeZoneSuggestion: (timeZone) => `Set channel time zone to ${timeZone}?`,
    locationTimeZoneAction: "Apply time zone",
    locationTimeZoneSaved: "Channel time zone updated.",
    locationTimeZoneSaveFailed: "Channel time zone could not be updated.",
  },
};

export const channelSettingsTexts = (language: "de" | "en"): ChannelSettingsTexts => texts[language];
