export const SUN_ERROR_TEXT_MAX_LENGTH = 200;

export interface SunLocation {
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface SunErrorTexts {
  de: string;
  en: string;
}

export interface SunSettings {
  location: SunLocation | null;
  errorTexts: SunErrorTexts;
  revision: number;
}
