import type { ModuleLanguage } from "../../contract";

export interface WeatherSettingsTexts {
  settings: string;
  provider: string;
  fahrenheit: string;
  fahrenheitHint: string;
  errorTexts: string;
  errorTextsHint: string;
  unavailableDe: string;
  unavailableEn: string;
  save: string;
  saved: string;
  loadFailed: string;
  saveFailed: string;
  settingsConflict: string;
  readOnlyReason: string;
  sources: string;
  metAttribution: string;
  openMeteoAttribution: string;
  metLicense: string;
}

const texts: Readonly<Record<ModuleLanguage, WeatherSettingsTexts>> = {
  de: {
    settings: "Wettereinstellungen",
    provider: "Wetteranbieter",
    fahrenheit: "°F zusätzlich anzeigen",
    fahrenheitHint: "Zeigt Fahrenheit neben Celsius an.",
    errorTexts: "Fehlertext bei nicht verfügbaren Wetterdaten",
    errorTextsHint: "Diese Texte erscheinen, wenn der Standort oder der Wetterdienst nicht verfügbar ist. Leere Felder verwenden den Standardtext.",
    unavailableDe: "Deutsch",
    unavailableEn: "Englisch",
    save: "Einstellungen speichern",
    saved: "Die Wetterdaten-Einstellungen wurden gespeichert.",
    loadFailed: "Die Wettereinstellungen konnten nicht geladen werden.",
    saveFailed: "Die Wettereinstellungen konnten nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    readOnlyReason: "Operatoren können diese Einstellung lesen, aber nicht ändern.",
    sources: "Quellen und Namensnennung",
    metAttribution: "Wetterdaten: MET Norway",
    openMeteoAttribution: "Wetterdaten von Open-Meteo.com",
    metLicense: "Lizenz: Creative Commons Namensnennung 4.0 International (CC BY 4.0).",
  },
  en: {
    settings: "Weather settings",
    provider: "Weather provider",
    fahrenheit: "Show °F alongside",
    fahrenheitHint: "Shows Fahrenheit next to Celsius.",
    errorTexts: "Error text for unavailable weather data",
    errorTextsHint: "These texts appear when the location or weather service is unavailable. Empty fields use the default text.",
    unavailableDe: "German",
    unavailableEn: "English",
    save: "Save settings",
    saved: "Weather settings saved.",
    loadFailed: "Weather settings could not be loaded.",
    saveFailed: "Weather settings could not be saved.",
    settingsConflict: "Settings changed in another session. Reload and try again.",
    readOnlyReason: "Operators can read this setting but cannot change it.",
    sources: "Sources and credits",
    metAttribution: "Weather data: MET Norway",
    openMeteoAttribution: "Weather data by Open-Meteo.com",
    metLicense: "License: Creative Commons Attribution 4.0 International (CC BY 4.0).",
  },
};

export const weatherSettingsTexts = (language: ModuleLanguage): WeatherSettingsTexts => texts[language];
