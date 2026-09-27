import type { ModuleLanguage } from "../../contract";

export interface SunLocationTexts {
  location: string;
  locationHint: string;
  search: string;
  searchButton: string;
  searching: string;
  selectLocation: string;
  removeLocation: string;
  selected: string;
  noResults: string;
  searchFailed: string;
  save: string;
  saved: string;
  loadFailed: string;
  saveFailed: string;
  settingsConflict: string;
  errorTexts: string;
  errorTextsHint: string;
  unavailableDe: string;
  unavailableEn: string;
  timezoneSuggestion: string;
  useSuggestedTimeZone: string;
  timezoneSaved: string;
  timezoneSaveFailed: string;
  readOnlyReason: string;
}

const texts: Readonly<Record<ModuleLanguage, SunLocationTexts>> = {
  de: {
    location: "Standort",
    locationHint: "Die Koordinaten werden für Sonnenzeiten verwendet. Die Zeitzone kann für die Kanalzeitzone übernommen werden.",
    search: "Stadt oder Postleitzahl",
    searchButton: "Suchen",
    searching: "Standorte werden gesucht …",
    selectLocation: "Standort auswählen",
    removeLocation: "Standort entfernen",
    selected: "Ausgewählt",
    noResults: "Keine passenden Standorte gefunden.",
    searchFailed: "Die Standortsuche ist derzeit nicht verfügbar.",
    save: "Einstellungen speichern",
    saved: "Standort gespeichert. Sonnenzeiten werden aktualisiert.",
    loadFailed: "Die Sonneneinstellungen konnten nicht geladen werden.",
    saveFailed: "Die Sonneneinstellungen konnten nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    errorTexts: "Fehlertext bei fehlenden Sonnendaten",
    errorTextsHint: "Dieser Text erscheint, wenn keine gültigen Sonnendaten vorliegen. Leere Felder verwenden den Standardtext.",
    unavailableDe: "Deutsch",
    unavailableEn: "Englisch",
    timezoneSuggestion: "Standortzeitzone",
    useSuggestedTimeZone: "Als Kanalzeitzone übernehmen",
    timezoneSaved: "Die Kanalzeitzone wurde aktualisiert.",
    timezoneSaveFailed: "Die Kanalzeitzone konnte nicht aktualisiert werden.",
    readOnlyReason: "Operatoren können diese Einstellung lesen, aber nicht ändern.",
  },
  en: {
    location: "Location",
    locationHint: "Coordinates are used for sun times. You can apply the location time zone to the channel setting.",
    search: "City or postal code",
    searchButton: "Search",
    searching: "Searching locations …",
    selectLocation: "Select location",
    removeLocation: "Remove location",
    selected: "Selected",
    noResults: "No matching locations found.",
    searchFailed: "Location search is currently unavailable.",
    save: "Save settings",
    saved: "Location saved. Sun times are being refreshed.",
    loadFailed: "Sun settings could not be loaded.",
    saveFailed: "Sun settings could not be saved.",
    settingsConflict: "Settings changed in another session. Reload and try again.",
    errorTexts: "Error text when sun data is unavailable",
    errorTextsHint: "This text appears when there are no valid sun times. Empty fields use the default text.",
    unavailableDe: "German",
    unavailableEn: "English",
    timezoneSuggestion: "Location time zone",
    useSuggestedTimeZone: "Use as channel time zone",
    timezoneSaved: "Channel time zone updated.",
    timezoneSaveFailed: "Channel time zone could not be updated.",
    readOnlyReason: "Operators can read this setting but cannot change it.",
  },
};

export const sunLocationTexts = (language: ModuleLanguage): SunLocationTexts => texts[language];
