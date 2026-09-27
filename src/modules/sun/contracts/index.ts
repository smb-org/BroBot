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
  nextRefreshAt: string | null;
}

export interface SunStoredDay {
  localDate: string;
  sunriseAt: string | null;
  sunsetAt: string | null;
  duskAt: string | null;
  polarState: "normal" | "day" | "night";
  fetchedAt: string;
  expiresAt: string;
  channelTimeZone: string;
  locationRevision: number;
}

