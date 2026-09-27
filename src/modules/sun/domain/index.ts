import type { ModuleLanguage } from "../../contract";
import { sunModuleCatalog } from "../contracts/catalog";

export type SolarPolarState = "normal" | "day" | "night";

export interface SunDay {
  localDate: string;
  sunriseAt: string | null;
  sunsetAt: string | null;
  duskAt: string | null;
  polarState: SolarPolarState;
}

interface CalculateSunDayInput {
  latitude: number;
  longitude: number;
  localDate: string;
  timeZone: string;
}

interface ResolveSunTemplateValuesInput {
  days: readonly SunDay[];
  now: number;
  timeZone: string;
  language: ModuleLanguage;
  errorText: string;
  expiresAt: string | null;
}

export interface ResolvedSunTemplateValues {
  values: Readonly<Record<string, string>>;
  dataConditions: Readonly<Record<string, string>>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const SUNRISE_ZENITH = 90.833;
const CIVIL_DUSK_ZENITH = 96;

const dateParts = (date: string): { year: number; month: number; day: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? { year, month, day }
    : null;
};

const wallTimeUtc = (localDate: string, hour: number, minute: number, timeZone: string): number => {
  const parts = dateParts(localDate);
  if (parts === null) throw new RangeError("Invalid local calendar date.");
  const targetWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  let candidate = targetWallTime;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let index = 0; index < 3; index += 1) {
    const values = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    const seenWallTime = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    candidate = targetWallTime - (seenWallTime - candidate);
  }
  return candidate;
};

export const channelLocalDate = (instant: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${String(values.year)}-${String(values.month)}-${String(values.day)}`;
};

export const shiftLocalDate = (date: string, amount: number): string => {
  const parts = dateParts(date);
  if (parts === null) throw new RangeError("Invalid local calendar date.");
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return `${String(shifted.getUTCFullYear())}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
};

export const localDateTimeUtc = (date: string, hour: number, minute: number, timeZone: string): number =>
  wallTimeUtc(date, hour, minute, timeZone);

export const nextSunRefreshAt = (now: number, timeZone: string): number => {
  const today = channelLocalDate(now, timeZone);
  const todayRefresh = localDateTimeUtc(today, 0, 15, timeZone);
  return todayRefresh > now ? todayRefresh : localDateTimeUtc(shiftLocalDate(today, 1), 0, 15, timeZone);
};

export const sunRecordExpiryAt = (localDate: string, timeZone: string): number =>
  localDateTimeUtc(shiftLocalDate(localDate, 2), 0, 0, timeZone);

const degreesToRadians = (degrees: number): number => degrees * Math.PI / 180;
const radiansToDegrees = (radians: number): number => radians * 180 / Math.PI;
const normalizeDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** NOAA's Meeus-based apparent solar longitude, declination and equation of time. */
const solarTerms = (instant: number): { equationOfTime: number; declination: number } => {
  const julianDay = instant / DAY_MS + 2_440_587.5;
  const julianCentury = (julianDay - 2_451_545) / 36_525;
  const meanLongitude = normalizeDegrees(280.46646 + julianCentury * (36_000.76983 + julianCentury * 0.0003032));
  const meanAnomaly = normalizeDegrees(357.52911 + julianCentury * (35_999.05029 - 0.0001537 * julianCentury));
  const eccentricity = 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);
  const anomaly = degreesToRadians(meanAnomaly);
  const equationOfCenter = Math.sin(anomaly) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    Math.sin(2 * anomaly) * (0.019993 - 0.000101 * julianCentury) + Math.sin(3 * anomaly) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const omega = degreesToRadians(125.04 - 1_934.136 * julianCentury);
  const apparentLongitude = degreesToRadians(trueLongitude - 0.00569 - 0.00478 * Math.sin(omega));
  const meanObliquity = 23 + (26 + (21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - 0.001813 * julianCentury))) / 60) / 60;
  const correctedObliquity = degreesToRadians(meanObliquity + 0.00256 * Math.cos(omega));
  const declination = Math.asin(Math.sin(correctedObliquity) * Math.sin(apparentLongitude));
  const longitude = degreesToRadians(meanLongitude);
  const y = Math.tan(correctedObliquity / 2) ** 2;
  const equationOfTimeRadians = y * Math.sin(2 * longitude) - 2 * eccentricity * Math.sin(anomaly) +
    4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * longitude) -
    0.5 * y ** 2 * Math.sin(4 * longitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly);
  return { equationOfTime: 4 * radiansToDegrees(equationOfTimeRadians), declination };
};

const hourAngleForZenith = (latitude: number, declination: number, zenith: number): number | null => {
  const lat = latitude * Math.PI / 180;
  const cosine = Math.cos(zenith * Math.PI / 180) / (Math.cos(lat) * Math.cos(declination)) -
    Math.tan(lat) * Math.tan(declination);
  if (cosine < -1 || cosine > 1) return null;
  return Math.acos(cosine) * 180 / Math.PI;
};

const roundedIso = (instant: number): string => new Date(Math.round(instant / 60_000) * 60_000).toISOString();

/** NOAA's Meeus-based apparent solar calculation; output is UTC instants for a channel-local calendar date. */
export const calculateSunDay = (input: CalculateSunDayInput): SunDay => {
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
      !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    throw new RangeError("Invalid solar coordinates.");
  }
  if (dateParts(input.localDate) === null) throw new RangeError("Invalid local calendar date.");
  const localNoon = wallTimeUtc(input.localDate, 12, 0, input.timeZone);
  const terms = solarTerms(localNoon);
  const noonUtcMinutes = 720 - 4 * input.longitude - terms.equationOfTime;
  const utcDay = new Date(localNoon);
  const utcMidnight = Date.UTC(utcDay.getUTCFullYear(), utcDay.getUTCMonth(), utcDay.getUTCDate());
  const solarNoon = utcMidnight + noonUtcMinutes * 60_000;
  const sunriseAngle = hourAngleForZenith(input.latitude, terms.declination, SUNRISE_ZENITH);
  const duskAngle = hourAngleForZenith(input.latitude, terms.declination, CIVIL_DUSK_ZENITH);

  if (sunriseAngle === null) {
    const isPolarDay = Math.sin(input.latitude * Math.PI / 180) * Math.sin(terms.declination) > 0;
    return { localDate: input.localDate, sunriseAt: null, sunsetAt: null, duskAt: null, polarState: isPolarDay ? "day" : "night" };
  }

  const solveEvent = (direction: -1 | 1, zenith: number, initialAngle: number): string | null => {
    let candidate = solarNoon + direction * initialAngle * 4 * 60_000;
    for (let index = 0; index < 6; index += 1) {
      const eventTerms = solarTerms(candidate);
      const eventAngle = hourAngleForZenith(input.latitude, eventTerms.declination, zenith);
      if (eventAngle === null) return roundedIso(candidate);
      const eventSolarNoon = utcMidnight + (720 - 4 * input.longitude - eventTerms.equationOfTime) * 60_000;
      const updated = eventSolarNoon + direction * eventAngle * 4 * 60_000;
      if (Math.abs(updated - candidate) < 1_000) {
        candidate = updated;
        break;
      }
      candidate = updated;
    }
    return roundedIso(candidate);
  };

  return {
    localDate: input.localDate,
    sunriseAt: solveEvent(-1, SUNRISE_ZENITH, sunriseAngle),
    sunsetAt: solveEvent(1, SUNRISE_ZENITH, sunriseAngle),
    duskAt: duskAngle === null ? null : solveEvent(1, CIVIL_DUSK_ZENITH, duskAngle),
    polarState: "normal",
  };
};

const formatSunTime = (instant: number, timeZone: string, language: ModuleLanguage): string =>
  new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    timeZone,
    hour: language === "de" ? "2-digit" : "numeric",
    minute: "2-digit",
  }).format(instant);

const formatUntil = (instant: number, now: number, language: ModuleLanguage): string => {
  const minutes = Math.max(0, Math.ceil((instant - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const units = sunModuleCatalog[language].durationUnits;
  const parts = [
    ...(days === 0 ? [] : [`${String(days)} ${days === 1 ? units.day : units.days}`]),
    ...(remainingHours === 0 ? [] : [`${String(remainingHours)} ${units.hour}`]),
    ...(remainder === 0 && (days > 0 || remainingHours > 0) ? [] : [`${String(remainder)} ${units.minute}`]),
  ];
  return parts.join(" ");
};

const validInstant = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Resolve the next events from the retained two-day record; an expired record never supplies values. */
export const resolveSunTemplateValues = (input: ResolveSunTemplateValuesInput): ResolvedSunTemplateValues => {
  const expiry = input.expiresAt === null ? Number.NaN : Date.parse(input.expiresAt);
  const today = channelLocalDate(input.now, input.timeZone);
  const yesterday = shiftLocalDate(today, -1);
  const tomorrow = shiftLocalDate(today, 1);
  const usableDays = Number.isFinite(expiry) && expiry > input.now
    ? input.days.filter((day) => day.localDate === yesterday || day.localDate === today || day.localDate === tomorrow)
    : [];
  const byDate = new Map(usableDays.map((day) => [day.localDate, day]));
  const current = byDate.get(today);
  if (current === undefined) {
    return {
      values: Object.fromEntries(["sun.set", "sun.rise", "sun.dusk", "sun.set_in", "sun.rise_in"].map((name) => [name, input.errorText])),
      dataConditions: {},
    };
  }

  const events = {
    set: [current, byDate.get(tomorrow)].flatMap((day) => day === undefined ? [] : [day.sunsetAt]).flatMap((value) => value === null ? [] : [value]),
    rise: [current, byDate.get(tomorrow)].flatMap((day) => day === undefined ? [] : [day.sunriseAt]).flatMap((value) => value === null ? [] : [value]),
    dusk: [current, byDate.get(tomorrow)].flatMap((day) => day === undefined ? [] : [day.duskAt]).flatMap((value) => value === null ? [] : [value]),
  };
  const next = (values: readonly string[]): number | null => values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value >= input.now)
    .sort((left, right) => left - right)[0] ?? null;
  const set = next(events.set);
  const rise = next(events.rise);
  const dusk = next(events.dusk);
  const sunriseToday = validInstant(current.sunriseAt);
  const sunsetToday = validInstant(current.sunsetAt);
  const isNight = current.polarState === "night" || current.polarState === "normal" && (
    sunriseToday === null || sunsetToday === null
      ? false
      : input.now < sunriseToday || input.now >= sunsetToday
  );
  const error = input.errorText;

  return {
    values: {
      "sun.set": set === null ? error : formatSunTime(set, input.timeZone, input.language),
      "sun.rise": rise === null ? error : formatSunTime(rise, input.timeZone, input.language),
      "sun.dusk": dusk === null ? error : formatSunTime(dusk, input.timeZone, input.language),
      "sun.set_in": set === null ? error : formatUntil(set, input.now, input.language),
      "sun.rise_in": rise === null ? error : formatUntil(rise, input.now, input.language),
    },
    dataConditions: { "sun.phase": isNight ? "night" : "day" },
  };
};
