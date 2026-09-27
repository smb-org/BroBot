import type { ModuleLanguage } from "../../contract";
import { WEATHER_CONDITION_LABELS } from "../contracts/catalog";
import type { NormalizedWeather, WeatherCondition } from "../contracts";

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export const weatherConditionFromMetSymbol = (symbol: string | undefined): WeatherCondition => {
  if (symbol === undefined) return "unknown";
  const code = symbol.toLowerCase().replace(/_(?:day|night|polartwilight)$/u, "");
  if (code.startsWith("clearsky")) return "clear";
  if (code.startsWith("fair")) return "mostly_clear";
  if (code.startsWith("partlycloudy")) return "partly_cloudy";
  if (code.includes("thunder")) return "thunderstorm";
  if (code.includes("snow") && code.includes("rain")) return "sleet";
  if (code.includes("snow")) return "snow";
  if (code.includes("sleet")) return "sleet";
  if (code.includes("rain") || code.includes("shower")) return "rain";
  if (code.includes("fog")) return "fog";
  if (code === "cloudy") return "cloudy";
  return "unknown";
};

export const weatherConditionFromWmoCode = (code: number | undefined): WeatherCondition => {
  if (code === 0) return "clear";
  if (code === 1) return "mostly_clear";
  if (code === 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code !== undefined && [56, 57, 66, 67].includes(code)) return "sleet";
  if (code !== undefined && [71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if (code !== undefined && [95, 96, 97, 99].includes(code)) return "thunderstorm";
  if (code !== undefined && [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "rain";
  return "unknown";
};

/** Approximate apparent temperature using standard wind-chill and heat-index equations. */
export const feelsLikeTemperatureC = (temperatureC: number, windSpeedMps: number, humidityPercent: number): number => {
  if (temperatureC <= 10 && windSpeedMps >= 1.34) {
    const windKph = windSpeedMps * 3.6;
    const windChill = 13.12 + 0.6215 * temperatureC - 11.37 * (windKph ** 0.16) + 0.3965 * temperatureC * (windKph ** 0.16);
    return clamp(windChill, temperatureC - 25, temperatureC + 10);
  }
  if (temperatureC >= 27 && humidityPercent >= 40) {
    const fahrenheit = temperatureC * 9 / 5 + 32;
    const relativeHumidity = humidityPercent;
    const heatIndex = -42.379 + 2.04901523 * fahrenheit + 10.14333127 * relativeHumidity
      - 0.22475541 * fahrenheit * relativeHumidity - 0.00683783 * fahrenheit ** 2
      - 0.05481717 * relativeHumidity ** 2 + 0.00122874 * fahrenheit ** 2 * relativeHumidity
      + 0.00085282 * fahrenheit * relativeHumidity ** 2 - 0.00000199 * fahrenheit ** 2 * relativeHumidity ** 2;
    return clamp((heatIndex - 32) * 5 / 9, temperatureC, temperatureC + 20);
  }
  return temperatureC;
};

const number = (value: number, language: ModuleLanguage, digits = 1): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: digits }).format(value);

const temperatureText = (value: number, language: ModuleLanguage, showFahrenheit: boolean): string => {
  const celsius = `${number(value, language)} °C`;
  if (!showFahrenheit) return celsius;
  return `${celsius} / ${number(value * 9 / 5 + 32, language)} °F`;
};

const conditionEmoji = (condition: WeatherCondition, isDay: boolean): string => {
  if (!isDay && (condition === "clear" || condition === "mostly_clear")) return "🌙";
  switch (condition) {
    case "clear": return "☀️";
    case "mostly_clear": return "🌤️";
    case "partly_cloudy": return "⛅";
    case "cloudy": return "☁️";
    case "fog": return "🌫️";
    case "rain": return "🌧️";
    case "snow": return "❄️";
    case "sleet": return "🌨️";
    case "thunderstorm": return "⛈️";
    case "unknown": return "🌡️";
  }
};

const shortForecast = (weather: NormalizedWeather, language: ModuleLanguage): string => {
  const condition = WEATHER_CONDITION_LABELS[language][weather.shortForecast];
  const precipitation = weather.precipitationMm > 0.05
    ? language === "de" ? `, ${number(weather.precipitationMm, language)} mm Niederschlag` : `, ${number(weather.precipitationMm, language)} mm precipitation`
    : "";
  return `${condition}${precipitation}`;
};

export const resolveWeatherValues = (input: {
  names: readonly string[];
  locationName: string;
  weather: NormalizedWeather;
  language: ModuleLanguage;
  timeZone: string;
  showFahrenheit: boolean;
}): Readonly<Record<string, string>> => {
  const { names, locationName, weather, language, timeZone, showFahrenheit } = input;
  const condition = `${conditionEmoji(weather.condition, weather.isDay)} ${WEATHER_CONDITION_LABELS[language][weather.condition]}`;
  const locale = language === "de" ? "de-DE" : "en-US";
  const values: Readonly<Record<string, string>> = {
    "weather.place": locationName,
    "weather.condition": condition,
    "weather.temp": temperatureText(weather.temperatureC, language, showFahrenheit),
    "weather.feels_like": temperatureText(weather.feelsLikeC, language, showFahrenheit),
    "weather.wind": language === "de" ? `${number(weather.windSpeedMps * 3.6, language)} km/h` : `${number(weather.windSpeedMps * 2.236936, language)} mph`,
    "weather.precipitation": `${number(weather.precipitationMm, language)} mm`,
    "weather.humidity": `${number(weather.humidityPercent, language, 0)} %`,
    "weather.observed_at": new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(Date.parse(weather.observedAt)),
    "weather.forecast": shortForecast(weather, language),
  };
  return Object.fromEntries(names.flatMap((name) => values[name] === undefined ? [] : [[name, values[name]]]));
};

export const normalizeCoordinates = (latitude: number, longitude: number): { latitude: number; longitude: number; key: string } => {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError("Weather coordinates are outside their valid range.");
  }
  const roundedLatitude = Number(latitude.toFixed(4));
  const roundedLongitude = Number(longitude.toFixed(4));
  return {
    latitude: roundedLatitude,
    longitude: roundedLongitude,
    key: `${roundedLatitude.toFixed(4)},${roundedLongitude.toFixed(4)}`,
  };
};
