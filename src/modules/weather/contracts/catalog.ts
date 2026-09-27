import type { ModuleLanguage } from "../../contract";
import type { WeatherCondition, WeatherProviderId } from ".";

export const WEATHER_TEMPLATE_VARIABLE_NAMES = [
  "weather.place", "weather.condition", "weather.temp", "weather.feels_like", "weather.wind",
  "weather.precipitation", "weather.humidity", "weather.observed_at", "weather.forecast",
] as const;

export type WeatherTemplateVariableName = (typeof WEATHER_TEMPLATE_VARIABLE_NAMES)[number];

export interface WeatherTemplateVariableText {
  label: string;
  description: string;
  sample: string;
}

export const WEATHER_CONDITION_LABELS: Readonly<Record<ModuleLanguage, Readonly<Record<WeatherCondition, string>>>> = {
  de: {
    clear: "Klar", mostly_clear: "Überwiegend klar", partly_cloudy: "Teilweise bewölkt", cloudy: "Bewölkt",
    fog: "Nebel", rain: "Regen", snow: "Schnee", sleet: "Schneeregen", thunderstorm: "Gewitter", unknown: "Unbekannt",
  },
  en: {
    clear: "Clear", mostly_clear: "Mostly clear", partly_cloudy: "Partly cloudy", cloudy: "Cloudy",
    fog: "Fog", rain: "Rain", snow: "Snow", sleet: "Sleet", thunderstorm: "Thunderstorm", unknown: "Unknown",
  },
};

export const weatherModuleCatalog: Readonly<Record<ModuleLanguage, {
  label: string;
  description: string;
  variableGroup: string;
  unavailableText: string;
  unknownPlace: string;
  condition: string;
  mandatoryReason: string;
  providers: Readonly<Record<WeatherProviderId, { label: string; description: string }>>;
  templateVariables: Readonly<Record<WeatherTemplateVariableName, WeatherTemplateVariableText>>;
}>> = {
  de: {
    label: "Wetter",
    description: "Wetterwerte für den Kanalstandort oder einen Ort im Befehl.",
    variableGroup: "Wetter",
    unavailableText: "Wetterdaten sind derzeit nicht verfügbar.",
    unknownPlace: "Ort nicht gefunden.",
    condition: "Wetterlage",
    mandatoryReason: "Die Wetterdatenquelle stellt Wetterwerte für Vorlagen bereit.",
    providers: {
      met_norway: { label: "MET Norway", description: "Standardanbieter, kostenfrei und auch kommerziell nutzbar." },
      open_meteo: { label: "Open-Meteo", description: "Kostenlose Nutzung nur für nicht-kommerzielle Projekte." },
    },
    templateVariables: {
      "weather.place": { label: "Wetterort", description: "Name des Orts, für den die Wetterwerte gelten.", sample: "Berlin" },
      "weather.condition": { label: "Wetterlage", description: "Aktuelle Wetterlage mit passendem Tag- oder Nacht-Emoji.", sample: "☀️ Klar" },
      "weather.temp": { label: "Temperatur", description: "Aktuelle Temperatur in °C; optional zusätzlich in °F.", sample: "18,4 °C" },
      "weather.feels_like": { label: "Gefühlte Temperatur", description: "Gefühlte Temperatur in °C; optional zusätzlich in °F.", sample: "17,8 °C" },
      "weather.wind": { label: "Wind", description: "Windgeschwindigkeit, lokal formatiert.", sample: "12 km/h" },
      "weather.precipitation": { label: "Niederschlag", description: "Niederschlagsmenge der nächsten Stunde.", sample: "0,2 mm" },
      "weather.humidity": { label: "Luftfeuchtigkeit", description: "Relative Luftfeuchtigkeit.", sample: "64 %" },
      "weather.observed_at": { label: "Messzeit", description: "Zeitpunkt der aktuellen Beobachtung in der Ortszeitzone.", sample: "14:30" },
      "weather.forecast": { label: "Kurzprognose", description: "Kurze Wetterprognose für die nächste Stunde.", sample: "Leichter Regen" },
    },
  },
  en: {
    label: "Weather",
    description: "Weather values for the channel location or a place in the command.",
    variableGroup: "Weather",
    unavailableText: "Weather data is currently unavailable.",
    unknownPlace: "Place not found.",
    condition: "Weather condition",
    mandatoryReason: "The weather data source provides weather values for templates.",
    providers: {
      met_norway: { label: "MET Norway", description: "Default provider, free for commercial use." },
      open_meteo: { label: "Open-Meteo", description: "Free use is limited to non-commercial projects." },
    },
    templateVariables: {
      "weather.place": { label: "Weather location", description: "Name of the place covered by the weather values.", sample: "Berlin" },
      "weather.condition": { label: "Condition", description: "Current condition with a matching day or night emoji.", sample: "☀️ Clear" },
      "weather.temp": { label: "Temperature", description: "Current temperature in °C, optionally with °F alongside.", sample: "18.4 °C" },
      "weather.feels_like": { label: "Feels like", description: "Feels-like temperature in °C, optionally with °F alongside.", sample: "17.8 °C" },
      "weather.wind": { label: "Wind", description: "Wind speed formatted for the channel language.", sample: "7 mph" },
      "weather.precipitation": { label: "Precipitation", description: "Precipitation amount for the next hour.", sample: "0.2 mm" },
      "weather.humidity": { label: "Humidity", description: "Relative humidity.", sample: "64%" },
      "weather.observed_at": { label: "Observation time", description: "Time of the latest observation in the location time zone.", sample: "2:30 PM" },
      "weather.forecast": { label: "Short forecast", description: "A short forecast for the next hour.", sample: "Light rain" },
    },
  },
};
