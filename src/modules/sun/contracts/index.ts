export const SUN_ERROR_TEXT_MAX_LENGTH = 200;

interface SunErrorTexts {
  de: string;
  en: string;
}

export interface SunSettings {
  errorTexts: SunErrorTexts;
  revision: number;
}
