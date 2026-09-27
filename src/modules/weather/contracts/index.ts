export const WEATHER_PROVIDERS = ["met_norway", "open_meteo"] as const;
export type WeatherProviderId = (typeof WEATHER_PROVIDERS)[number];

export const WEATHER_CONDITIONS = [
  "clear", "mostly_clear", "partly_cloudy", "cloudy", "fog", "rain", "snow", "sleet", "thunderstorm", "unknown",
] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export const WEATHER_ERROR_TEXT_MAX_LENGTH = 200;

export interface WeatherErrorTexts {
  de: string;
  en: string;
}

export interface WeatherSettings {
  provider: WeatherProviderId;
  showFahrenheit: boolean;
  errorTexts: WeatherErrorTexts;
  revision: number;
}

export interface NormalizedWeather {
  temperatureC: number;
  feelsLikeC: number;
  condition: WeatherCondition;
  isDay: boolean;
  windSpeedMps: number;
  precipitationMm: number;
  humidityPercent: number;
  observedAt: string;
  shortForecast: WeatherCondition;
}
