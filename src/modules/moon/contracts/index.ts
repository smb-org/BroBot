export const MOON_ERROR_TEXT_MAX_LENGTH = 200;

export interface MoonErrorTexts {
  de: string;
  en: string;
}

export interface MoonSettings {
  errorTexts: MoonErrorTexts;
  revision: number;
}
