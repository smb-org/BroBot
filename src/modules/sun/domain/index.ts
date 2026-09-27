import type { ModuleLanguage } from "../../contract";
import { sunModuleCatalog } from "../contracts/catalog";

export type SolarPolarState = "normal" | "day" | "night";

export interface SunDay {
  localDate: string;
  sunriseAt: string | null;
  sunsetAt: string | null;
  dawnAt: string | null;
  duskAt: string | null;
  solarNoonAt: string;
  dayLengthMinutes: number | null;
  polarState: SolarPolarState;
}

export interface CalculateSunDayInput {
  latitude: number;
  longitude: number;
  localDate: string;
  timeZone: string;
}

interface ResolveSunTemplateValuesInput {
  location: {
    latitude: number;
    longitude: number;
    timeZone: string;
  } | null;
  now: number;
  /** Channel time zone controls presentation; solar dates use location.timeZone. */
  timeZone: string;
  language: ModuleLanguage;
  errorText: string;
}

export interface ResolvedSunTemplateValues {
  values: Readonly<Record<string, string>>;
  dataConditions: Readonly<Record<string, string>>;
}

const SUNRISE_ZENITH = 90.833;
const CIVIL_DUSK_ZENITH = 96;
const DAY_MS = 24 * 60 * 60 * 1_000;

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

export const localMidnightInTimeZone = (localDate: string, timeZone: string): string =>
  new Date(wallTimeUtc(localDate, 0, 0, timeZone)).toISOString();

export const localDateInTimeZone = (instant: number, timeZone: string): string => {
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

interface SolarNoonAnchor {
  utcMidnight: number;
  solarNoon: number;
  terms: { equationOfTime: number; declination: number };
}

const solarNoonForUtcMidnight = (utcMidnight: number, longitude: number): SolarNoonAnchor => {
  let solarNoon = utcMidnight + (720 - 4 * longitude) * 60_000;
  for (let index = 0; index < 4; index += 1) {
    const terms = solarTerms(solarNoon);
    const updated = utcMidnight + (720 - 4 * longitude - terms.equationOfTime) * 60_000;
    if (Math.abs(updated - solarNoon) < 1_000) {
      solarNoon = updated;
      return { utcMidnight, solarNoon, terms: solarTerms(solarNoon) };
    }
    solarNoon = updated;
  }
  return { utcMidnight, solarNoon, terms: solarTerms(solarNoon) };
};

/** NOAA's Meeus-based apparent solar calculation; output is UTC instants for a location-local calendar date. */
export const calculateSunDay = (input: CalculateSunDayInput): SunDay => {
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
      !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    throw new RangeError("Invalid solar coordinates.");
  }
  if (dateParts(input.localDate) === null) throw new RangeError("Invalid local calendar date.");
  const localNoon = wallTimeUtc(input.localDate, 12, 0, input.timeZone);
  const localNoonUtcDay = new Date(localNoon);
  const firstUtcMidnight = Date.UTC(localNoonUtcDay.getUTCFullYear(), localNoonUtcDay.getUTCMonth(), localNoonUtcDay.getUTCDate());
  const anchor = [-3, -2, -1, 0, 1, 2, 3]
    .map((offset) => solarNoonForUtcMidnight(firstUtcMidnight + offset * DAY_MS, input.longitude))
    .find((candidate) => localDateInTimeZone(candidate.solarNoon, input.timeZone) === input.localDate);
  if (anchor === undefined) throw new RangeError("Could not anchor solar noon to the requested local date.");
  const { utcMidnight, solarNoon, terms } = anchor;
  const sunriseAngle = hourAngleForZenith(input.latitude, terms.declination, SUNRISE_ZENITH);
  const duskAngle = hourAngleForZenith(input.latitude, terms.declination, CIVIL_DUSK_ZENITH);

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

  if (sunriseAngle === null) {
    const isPolarDay = Math.sin(input.latitude * Math.PI / 180) * Math.sin(terms.declination) > 0;
    return {
      localDate: input.localDate,
      sunriseAt: null,
      sunsetAt: null,
      dawnAt: duskAngle === null ? null : solveEvent(-1, CIVIL_DUSK_ZENITH, duskAngle),
      duskAt: duskAngle === null ? null : solveEvent(1, CIVIL_DUSK_ZENITH, duskAngle),
      solarNoonAt: roundedIso(solarNoon),
      dayLengthMinutes: null,
      polarState: isPolarDay ? "day" : "night",
    };
  }

  const sunriseAt = solveEvent(-1, SUNRISE_ZENITH, sunriseAngle);
  const sunsetAt = solveEvent(1, SUNRISE_ZENITH, sunriseAngle);
  return {
    localDate: input.localDate,
    sunriseAt,
    sunsetAt,
    dawnAt: duskAngle === null ? null : solveEvent(-1, CIVIL_DUSK_ZENITH, duskAngle),
    duskAt: duskAngle === null ? null : solveEvent(1, CIVIL_DUSK_ZENITH, duskAngle),
    solarNoonAt: roundedIso(solarNoon),
    dayLengthMinutes: sunriseAt === null || sunsetAt === null
      ? null
      : Math.round((Date.parse(sunsetAt) - Date.parse(sunriseAt)) / 60_000),
    polarState: "normal",
  };
};

const solarAltitude = (instant: number, latitude: number, longitude: number): number => {
  const terms = solarTerms(instant);
  const date = new Date(instant);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMinutes = ((utcMinutes + terms.equationOfTime + 4 * longitude) % 1_440 + 1_440) % 1_440;
  const hourAngle = degreesToRadians(trueSolarMinutes / 4 - 180);
  const lat = degreesToRadians(latitude);
  const sineAltitude = Math.sin(lat) * Math.sin(terms.declination) +
    Math.cos(lat) * Math.cos(terms.declination) * Math.cos(hourAngle);
  return radiansToDegrees(Math.asin(Math.max(-1, Math.min(1, sineAltitude))));
};

interface SolarAltitudeCrossing {
  at: string;
  rising: boolean;
}

/** Find altitude crossings inside a location-local calendar date. */
const altitudeCrossings = (
  location: CalculateSunDayInput,
  altitude: number,
): SolarAltitudeCrossing[] => {
  const start = wallTimeUtc(location.localDate, 0, 0, location.timeZone);
  const end = wallTimeUtc(shiftLocalDate(location.localDate, 1), 0, 0, location.timeZone);
  const step = 10 * 60_000;
  const crossings: SolarAltitudeCrossing[] = [];
  let left = start;
  let leftValue = solarAltitude(left, location.latitude, location.longitude) - altitude;
  for (let right = Math.min(left + step, end); right <= end; right = Math.min(right + step, end)) {
    const rightValue = solarAltitude(right, location.latitude, location.longitude) - altitude;
    if (Math.sign(leftValue) !== Math.sign(rightValue)) {
      let low = left;
      let high = right;
      let lowValue = leftValue;
      for (let index = 0; index < 32 && high - low > 500; index += 1) {
        const middle = (low + high) / 2;
        const middleValue = solarAltitude(middle, location.latitude, location.longitude) - altitude;
        if (Math.sign(lowValue) === Math.sign(middleValue)) {
          low = middle;
          lowValue = middleValue;
        } else {
          high = middle;
        }
      }
      const instant = (low + high) / 2;
      const before = solarAltitude(instant - 60_000, location.latitude, location.longitude);
      const after = solarAltitude(instant + 60_000, location.latitude, location.longitude);
      const event = roundedIso(instant);
      if (Date.parse(event) > start && Date.parse(event) < end &&
          !crossings.some((crossing) => crossing.at === event)) {
        crossings.push({ at: event, rising: after > before });
      }
    }
    if (right === end) break;
    left = right;
    leftValue = rightValue;
  }
  return crossings.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
};

type SunPhase = "day" | "night" | "golden_hour" | "blue_hour";

const phaseForInstant = (location: CalculateSunDayInput, instant: number): SunPhase => {
  const localDate = localDateInTimeZone(instant, location.timeZone);
  const day = calculateSunDay({ ...location, localDate });
  const altitude = solarAltitude(instant, location.latitude, location.longitude);
  if (altitude >= -6 && altitude < -4) return "blue_hour";
  if (altitude >= -4 && altitude <= 6) return "golden_hour";
  if (day.polarState === "day") return "day";
  if (day.polarState === "night") return "night";
  const rise = validInstant(day.sunriseAt);
  const set = validInstant(day.sunsetAt);
  return rise !== null && set !== null && instant >= rise && instant < set ? "day" : "night";
};

export const calculateSunPhaseTransitions = (
  location: CalculateSunDayInput,
  from: number,
  until: number,
): readonly { at: string; phase: SunPhase }[] => {
  if (until <= from) return [];
  const firstDate = localDateInTimeZone(from, location.timeZone);
  const lastDate = localDateInTimeZone(until, location.timeZone);
  const result: { at: string; phase: SunPhase }[] = [];
  for (let date = firstDate, guard = 0; date <= lastDate && guard < 40; date = shiftLocalDate(date, 1), guard += 1) {
    const input = { ...location, localDate: date };
    const day = calculateSunDay(input);
    const changes = [day.sunriseAt, day.sunsetAt, ...[-6, -4, 6].flatMap((threshold) =>
      altitudeCrossings(input, threshold).map(({ at }) => at))]
      .filter((at): at is string => at !== null)
      .filter((at) => Date.parse(at) > from && Date.parse(at) <= until)
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    for (const at of changes) {
      const instant = Date.parse(at);
      const before = phaseForInstant(location, instant - 60_000);
      const after = phaseForInstant(location, instant + 60_000);
      if (before !== after) result.push({ at, phase: after });
    }
  }
  return result.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
};

export interface SunAltitudeInterval {
  startAt: string;
  endAt: string;
}

/** Calculate all local golden-hour or blue-hour intervals from altitude crossings. */
export const calculateSunAltitudeIntervals = (
  location: Omit<CalculateSunDayInput, "localDate">,
  firstLocalDate: string,
  dayCount: number,
  kind: "golden" | "blue",
): readonly SunAltitudeInterval[] => {
  const intervals: SunAltitudeInterval[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const localDate = shiftLocalDate(firstLocalDate, offset);
    const dayLocation = { ...location, localDate };
    const risingStartThreshold = kind === "golden" ? -4 : -6;
    const risingEndThreshold = kind === "golden" ? 6 : -4;
    const settingStartThreshold = kind === "golden" ? 6 : -4;
    const settingEndThreshold = kind === "golden" ? -4 : -6;
    const starts = [
      ...altitudeCrossings(dayLocation, risingStartThreshold).filter(({ rising }) => rising),
      ...altitudeCrossings(dayLocation, settingStartThreshold).filter(({ rising }) => !rising),
    ].map(({ at }) => at).sort((left, right) => Date.parse(left) - Date.parse(right));
    const ends = [
      ...altitudeCrossings(dayLocation, risingEndThreshold).filter(({ rising }) => rising),
      ...altitudeCrossings(dayLocation, settingEndThreshold).filter(({ rising }) => !rising),
    ].map(({ at }) => at).sort((left, right) => Date.parse(left) - Date.parse(right));
    for (const startAt of starts) {
      const endAt = ends.find((candidate) => Date.parse(candidate) > Date.parse(startAt));
      if (endAt !== undefined) intervals.push({ startAt, endAt });
    }
  }
  return intervals.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
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

/** Calculate adjacent location-local solar days and resolve the next future events. */
export const resolveSunTemplateValues = (input: ResolveSunTemplateValuesInput): ResolvedSunTemplateValues => {
  const location = input.location;
  const variableNames = [
    "sun.set", "sun.rise", "sun.dusk", "sun.dawn", "sun.noon", "sun.day_length",
    "sun.golden_hour", "sun.golden_hour_in", "sun.golden_hour_end", "sun.blue_hour", "sun.blue_hour_in",
    "sun.set_in", "sun.rise_in", "sun.dawn_in",
  ];
  if (location === null) {
    return {
      values: Object.fromEntries(variableNames.map((name) => [name, input.errorText])),
      dataConditions: {},
    };
  }

  const today = localDateInTimeZone(input.now, location.timeZone);
  const days = [-1, 0, 1, 2].map((offset) => calculateSunDay({
    ...location,
    localDate: shiftLocalDate(today, offset),
  }));
  const current = days.find((day) => day.localDate === today);
  if (current === undefined) throw new RangeError("Could not calculate the current location-local solar day.");

  const events = {
    set: days.flatMap((day) => day.sunsetAt === null ? [] : [day.sunsetAt]),
    rise: days.flatMap((day) => day.sunriseAt === null ? [] : [day.sunriseAt]),
    dusk: days.flatMap((day) => day.duskAt === null ? [] : [day.duskAt]),
    dawn: days.flatMap((day) => day.dawnAt === null ? [] : [day.dawnAt]),
    noon: days.map((day) => day.solarNoonAt),
  };
  const next = (values: readonly string[]): number | null => values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value > input.now)
    .sort((left, right) => left - right)[0] ?? null;
  const set = next(events.set);
  const rise = next(events.rise);
  const dusk = next(events.dusk);
  const dawn = next(events.dawn);
  const noon = next(events.noon);
  const sunriseToday = validInstant(current.sunriseAt);
  const sunsetToday = validInstant(current.sunsetAt);
  const isNight = current.polarState === "night" || current.polarState === "normal" && (
    sunriseToday === null || sunsetToday === null
      ? false
      : input.now < sunriseToday || input.now >= sunsetToday
  );
  const altitude = solarAltitude(input.now, location.latitude, location.longitude);
  const phase = altitude >= -6 && altitude < -4
    ? "blue_hour"
    : altitude >= -4 && altitude <= 6
      ? "golden_hour"
      : isNight ? "night" : "day";
  const intervalsFor = (kind: "golden" | "blue"): { start: number; end: number }[] =>
    calculateSunAltitudeIntervals(location, shiftLocalDate(today, -1), 4, kind).map(({ startAt, endAt }) => ({
      start: Date.parse(startAt),
      end: Date.parse(endAt),
    }));
  const selectInterval = (intervals: readonly { start: number; end: number }[]): { start: number; end: number } | null =>
    intervals.find((interval) => interval.start <= input.now && input.now < interval.end) ??
    intervals.find((interval) => interval.start > input.now) ?? null;
  const goldenIntervals = intervalsFor("golden");
  const blueIntervals = intervalsFor("blue");
  const golden = selectInterval(goldenIntervals);
  const blue = selectInterval(blueIntervals);
  const formatDayLength = (): string => {
    if (current.dayLengthMinutes === null && current.polarState === "normal") return input.errorText;
    const minutes = current.dayLengthMinutes ?? (current.polarState === "day" ? 1_440 : 0);
    return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, "0")}`;
  };
  const error = input.errorText;

  return {
    values: {
      "sun.set": set === null ? error : formatSunTime(set, input.timeZone, input.language),
      "sun.rise": rise === null ? error : formatSunTime(rise, input.timeZone, input.language),
      "sun.dusk": dusk === null ? error : formatSunTime(dusk, input.timeZone, input.language),
      "sun.dawn": dawn === null ? error : formatSunTime(dawn, input.timeZone, input.language),
      "sun.noon": noon === null ? error : formatSunTime(noon, input.timeZone, input.language),
      "sun.day_length": formatDayLength(),
      "sun.golden_hour": golden === null ? error : formatSunTime(golden.start, input.timeZone, input.language),
      "sun.golden_hour_in": golden === null ? error : formatUntil(golden.start, input.now, input.language),
      "sun.golden_hour_end": golden === null ? error : formatSunTime(golden.end, input.timeZone, input.language),
      "sun.blue_hour": blue === null ? error : formatSunTime(blue.start, input.timeZone, input.language),
      "sun.blue_hour_in": blue === null ? error : formatUntil(blue.start, input.now, input.language),
      "sun.set_in": set === null ? error : formatUntil(set, input.now, input.language),
      "sun.rise_in": rise === null ? error : formatUntil(rise, input.now, input.language),
      "sun.dawn_in": dawn === null ? error : formatUntil(dawn, input.now, input.language),
    },
    dataConditions: { "sun.phase": phase },
  };
};
