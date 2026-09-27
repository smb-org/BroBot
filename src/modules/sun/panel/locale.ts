import type { ModuleLanguage } from "../../contract";

export interface SunSettingsTexts {
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
}

const texts: Readonly<Record<ModuleLanguage, SunSettingsTexts>> = {
  de: {
    errorTexts: "Fehlertexte bei fehlenden Sonnendaten",
    errorTextsHint: "Diese Texte erscheinen, wenn keine gültigen Sonnendaten vorliegen. Leere Felder verwenden den Standardtext.",
    unavailableDe: "Deutsch",
    unavailableEn: "Englisch",
    save: "Fehlertexte speichern",
    saved: "Die Fehlertexte wurden gespeichert.",
    loadFailed: "Die Sonneneinstellungen konnten nicht geladen werden.",
    saveFailed: "Die Fehlertexte konnten nicht gespeichert werden.",
    settingsConflict: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.",
    readOnlyReason: "Operatoren können diese Einstellung lesen, aber nicht ändern.",
  },
  en: {
    errorTexts: "Error texts for unavailable sun data",
    errorTextsHint: "These texts appear when no valid sun data is available. Empty fields use the default text.",
    unavailableDe: "German",
    unavailableEn: "English",
    save: "Save error texts",
    saved: "Error texts saved.",
    loadFailed: "Sun settings could not be loaded.",
    saveFailed: "Error texts could not be saved.",
    settingsConflict: "Settings changed in another session. Reload and try again.",
    readOnlyReason: "Operators can read this setting but cannot change it.",
  },
};

export const sunSettingsTexts = (language: ModuleLanguage): SunSettingsTexts => texts[language];
