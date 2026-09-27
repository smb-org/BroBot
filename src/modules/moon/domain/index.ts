import type { ModuleLanguage } from "../../contract";
import { moonModuleCatalog } from "../contracts/catalog";

const DAY_MS = 24 * 60 * 60 * 1_000;
const EARTH_EQUATORIAL_RADIUS_KM = 6_378.14;
const MOON_RADIUS_KM = 1_737.4;
const HORIZON_REFRACTION_DEGREES = 34 / 60;

type LunarLongitudeTerm = readonly [number, number, number, number, number, number];
type LunarLatitudeTerm = readonly [number, number, number, number, number];

// Periodic coefficients from Meeus, Astronomical Algorithms, Chapter 47, Tables 47.A and 47.B.
const LONGITUDE_DISTANCE_TERMS: readonly LunarLongitudeTerm[] = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];

const LATITUDE_TERMS: readonly LunarLatitudeTerm[] = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
];

export interface MoonPosition {
  rightAscension: number;
  declination: number;
  distanceKm: number;
  longitude: number;
  latitude: number;
}

export interface MoonDay {
  localDate: string;
  riseAt: string | null;
  setAt: string | null;
  state: "normal" | "always_up" | "always_down" | "no_crossing";
}

export interface MoonLocation {
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface ResolvedMoonTemplateValues {
  values: Readonly<Record<string, string>>;
  illumination: number;
  phase: string;
}

const degreesToRadians = (degrees: number): number => degrees * Math.PI / 180;
const radiansToDegrees = (radians: number): number => radians * 180 / Math.PI;
const normalizeDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;
const normalizeRadians = (radians: number): number => ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const julianDay = (instant: number): number => instant / DAY_MS + 2_440_587.5;

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

/** Meeus Chapter 47 lunar periodic terms transformed to apparent equatorial coordinates. */
export const calculateMoonPosition = (instant: number): MoonPosition => {
  const t = (julianDay(instant) - 2_451_545) / 36_525;
  const lPrime = normalizeDegrees(218.3164477 + (481267.88123421 + (-0.0015786 + (1 / 538841 - t / 65_194_000) * t) * t) * t);
  const d = normalizeDegrees(297.8501921 + (445267.1114034 + (-0.0018819 + (1 / 545868 - t / 113_065_000) * t) * t) * t);
  const m = normalizeDegrees(357.5291092 + (35999.0502909 + (-0.0001536 + t / 24_490_000) * t) * t);
  const mPrime = normalizeDegrees(134.9633964 + (477198.8675055 + (0.0087414 + (1 / 69699 - t / 14_712_000) * t) * t) * t);
  const f = normalizeDegrees(93.272095 + (483202.0175233 + (-0.0036539 + (-1 / 3_526_000 + t / 863_310_000) * t) * t) * t);
  const a1 = degreesToRadians(normalizeDegrees(119.75 + 131.849 * t));
  const a2 = degreesToRadians(normalizeDegrees(53.09 + 479264.29 * t));
  const a3 = degreesToRadians(normalizeDegrees(313.45 + 481266.484 * t));
  const fRad = degreesToRadians(f);
  const eccentricity = 1 - 0.002516 * t - 0.0000074 * t * t;
  let longitudeCorrection = 0;
  let distanceCorrection = 0;
  for (const [dMultiplier, mMultiplier, mPrimeMultiplier, fMultiplier, longitudeCoefficient, distanceCoefficient] of LONGITUDE_DISTANCE_TERMS) {
    const eccentricityFactor = Math.abs(mMultiplier) === 1 ? eccentricity : Math.abs(mMultiplier) === 2 ? eccentricity * eccentricity : 1;
    const argument = degreesToRadians(dMultiplier * d + mMultiplier * m + mPrimeMultiplier * mPrime + fMultiplier * f);
    longitudeCorrection += longitudeCoefficient * eccentricityFactor * Math.sin(argument);
    distanceCorrection += distanceCoefficient * eccentricityFactor * Math.cos(argument);
  }
  longitudeCorrection += 3958 * Math.sin(a1) + 1962 * Math.sin(degreesToRadians(lPrime) - fRad) + 318 * Math.sin(a2);
  let latitudeCorrection = 0;
  for (const [dMultiplier, mMultiplier, mPrimeMultiplier, fMultiplier, coefficient] of LATITUDE_TERMS) {
    const eccentricityFactor = Math.abs(mMultiplier) === 1 ? eccentricity : Math.abs(mMultiplier) === 2 ? eccentricity * eccentricity : 1;
    const argument = degreesToRadians(dMultiplier * d + mMultiplier * m + mPrimeMultiplier * mPrime + fMultiplier * f);
    latitudeCorrection += coefficient * eccentricityFactor * Math.sin(argument);
  }
  latitudeCorrection += -2235 * Math.sin(degreesToRadians(lPrime)) + 382 * Math.sin(a3) +
    175 * Math.sin(a1 - fRad) + 175 * Math.sin(a1 + fRad) +
    127 * Math.sin(degreesToRadians(lPrime - mPrime)) - 115 * Math.sin(degreesToRadians(lPrime + mPrime));

  const omega = degreesToRadians(normalizeDegrees(125.04452 - 1934.136261 * t + 0.0020708 * t * t + t * t * t / 450_000));
  const meanSolarLongitude = degreesToRadians(normalizeDegrees(280.4665 + 36000.7698 * t));
  const meanLunarLongitude = degreesToRadians(lPrime);
  const nutationLongitudeArcSeconds = -17.2 * Math.sin(omega) - 1.32 * Math.sin(2 * meanSolarLongitude) -
    0.23 * Math.sin(2 * meanLunarLongitude) + 0.21 * Math.sin(2 * omega);
  const longitude = normalizeDegrees(lPrime + longitudeCorrection / 1_000_000 + nutationLongitudeArcSeconds / 3_600);
  const latitude = latitudeCorrection / 1_000_000;
  const distanceKm = 385000.56 + distanceCorrection / 1_000;
  const meanObliquityDegrees = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const trueObliquity = degreesToRadians(meanObliquityDegrees + 0.00256 * Math.cos(omega));
  const longitudeRad = degreesToRadians(longitude);
  const latitudeRad = degreesToRadians(latitude);
  const x = Math.cos(latitudeRad) * Math.cos(longitudeRad);
  const y = Math.cos(latitudeRad) * Math.sin(longitudeRad) * Math.cos(trueObliquity) - Math.sin(latitudeRad) * Math.sin(trueObliquity);
  const z = Math.cos(latitudeRad) * Math.sin(longitudeRad) * Math.sin(trueObliquity) + Math.sin(latitudeRad) * Math.cos(trueObliquity);
  return {
    longitude,
    latitude,
    distanceKm,
    rightAscension: normalizeRadians(Math.atan2(y, x)),
    declination: Math.asin(Math.max(-1, Math.min(1, z))),
  };
};

const solarApparentLongitude = (instant: number): number => {
  const jd = julianDay(instant);
  const t = (jd - 2_451_545) / 36_525;
  const meanLongitude = normalizeDegrees(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnomaly = normalizeDegrees(357.52911 + t * (35999.05029 - 0.0001537 * t));
  const anomaly = degreesToRadians(meanAnomaly);
  const center = Math.sin(anomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * anomaly) * (0.019993 - 0.000101 * t) + Math.sin(3 * anomaly) * 0.000289;
  const omega = degreesToRadians(125.04 - 1934.136 * t);
  return normalizeDegrees(meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega));
};

export const calculateMoonState = (instant: number): { phase: string; illumination: number } => {
  const moon = calculateMoonPosition(instant);
  const sunLongitude = degreesToRadians(solarApparentLongitude(instant));
  const moonLongitude = degreesToRadians(moon.longitude);
  const moonLatitude = degreesToRadians(moon.latitude);
  const elongationCosine = Math.cos(moonLatitude) * Math.cos(moonLongitude - sunLongitude);
  const illumination = Math.round(100 * (1 - elongationCosine) / 2);
  const elongation = radiansToDegrees(normalizeRadians(Math.atan2(
    Math.cos(moonLatitude) * Math.sin(moonLongitude - sunLongitude),
    elongationCosine,
  )));
  const phaseIndex = Math.floor((elongation + 22.5) / 45) % 8;
  return { phase: ["new", "waxing_crescent", "first_quarter", "waxing_gibbous", "full", "waning_gibbous", "last_quarter", "waning_crescent"][phaseIndex] ?? "new", illumination };
};

const greenwichMeanSiderealTime = (instant: number): number => {
  const jd = julianDay(instant);
  const t = (jd - 2_451_545) / 36_525;
  return normalizeRadians(degreesToRadians(280.46061837 + 360.98564736629 * (jd - 2_451_545) +
    0.000387933 * t * t - t * t * t / 38_710_000));
};

/** Apparent altitude of the Moon's upper limb after topocentric parallax and horizon refraction. */
const apparentUpperLimbAltitude = (instant: number, location: MoonLocation): number => {
  const moon = calculateMoonPosition(instant);
  const hourAngle = normalizeRadians(greenwichMeanSiderealTime(instant) + degreesToRadians(location.longitude) - moon.rightAscension + Math.PI) - Math.PI;
  const latitude = degreesToRadians(location.latitude);
  const sineAltitude = Math.sin(latitude) * Math.sin(moon.declination) +
    Math.cos(latitude) * Math.cos(moon.declination) * Math.cos(hourAngle);
  const geocentricAltitude = Math.asin(Math.max(-1, Math.min(1, sineAltitude)));
  const horizontalDistance = moon.distanceKm * Math.cos(geocentricAltitude);
  const verticalDistance = moon.distanceKm * Math.sin(geocentricAltitude) - EARTH_EQUATORIAL_RADIUS_KM;
  const topocentricAltitude = Math.atan2(verticalDistance, horizontalDistance);
  const semidiameter = radiansToDegrees(Math.asin(MOON_RADIUS_KM / moon.distanceKm));
  return radiansToDegrees(topocentricAltitude) + HORIZON_REFRACTION_DEGREES + semidiameter;
};

const roundedIso = (instant: number): string => new Date(Math.round(instant / 60_000) * 60_000).toISOString();

/** Meeus low-precision moonrise and moonset crossings for one location-local date. */
export const calculateMoonDay = (location: MoonLocation, localDate: string): MoonDay => {
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
      !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 || dateParts(localDate) === null) {
    throw new RangeError("Invalid lunar coordinates or local date.");
  }
  const start = wallTimeUtc(localDate, 0, 0, location.timeZone);
  const end = wallTimeUtc(shiftLocalDate(localDate, 1), 0, 0, location.timeZone);
  const step = 10 * 60_000;
  const crossings: { at: string; rising: boolean }[] = [];
  let left = start;
  let leftValue = apparentUpperLimbAltitude(left, location);
  let maximum = leftValue;
  let minimum = leftValue;
  for (let right = Math.min(left + step, end); right <= end; right = Math.min(right + step, end)) {
    const rightValue = apparentUpperLimbAltitude(right, location);
    maximum = Math.max(maximum, rightValue);
    minimum = Math.min(minimum, rightValue);
    if (Math.sign(leftValue) !== Math.sign(rightValue)) {
      let low = left;
      let high = right;
      let lowValue = leftValue;
      for (let index = 0; index < 32 && high - low > 500; index += 1) {
        const middle = (low + high) / 2;
        const middleValue = apparentUpperLimbAltitude(middle, location);
        if (Math.sign(lowValue) === Math.sign(middleValue)) {
          low = middle;
          lowValue = middleValue;
        } else {
          high = middle;
        }
      }
      const instant = (low + high) / 2;
      const at = roundedIso(instant);
      if (Date.parse(at) > start && Date.parse(at) < end && !crossings.some((crossing) => crossing.at === at)) {
        crossings.push({ at, rising: apparentUpperLimbAltitude(instant + 60_000, location) > apparentUpperLimbAltitude(instant - 60_000, location) });
      }
    }
    if (right === end) break;
    left = right;
    leftValue = rightValue;
  }
  const riseAt = crossings.find(({ rising }) => rising)?.at ?? null;
  const setAt = crossings.find(({ rising }) => !rising)?.at ?? null;
  const state = riseAt !== null && setAt !== null ? "normal" : maximum < 0 ? "always_down" : minimum > 0 ? "always_up" : "no_crossing";
  return { localDate, riseAt, setAt, state };
};

export const nextMoonEvents = (
  location: MoonLocation,
  now: number,
  maximumDays = 35,
): { riseAts: readonly string[]; setAts: readonly string[]; riseState: MoonDay["state"]; setState: MoonDay["state"] } => {
  const firstDate = localDateInTimeZone(now, location.timeZone);
  const riseAts: string[] = [];
  const setAts: string[] = [];
  let riseState: MoonDay["state"] = "no_crossing";
  let setState: MoonDay["state"] = "no_crossing";
  for (let offset = 0; offset < maximumDays && (riseAts.length < 8 || setAts.length < 8); offset += 1) {
    const day = calculateMoonDay(location, shiftLocalDate(firstDate, offset));
    if (offset === 0) {
      riseState = day.state;
      setState = day.state;
    }
    if (day.riseAt !== null && Date.parse(day.riseAt) > now) riseAts.push(day.riseAt);
    if (day.setAt !== null && Date.parse(day.setAt) > now) setAts.push(day.setAt);
  }
  return { riseAts, setAts, riseState, setState };
};

const formatMoonTime = (instant: number, timeZone: string, language: ModuleLanguage): string =>
  new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    timeZone,
    hour: language === "de" ? "2-digit" : "numeric",
    minute: "2-digit",
  }).format(instant);

const formatDuration = (instant: number, now: number, language: ModuleLanguage): string => {
  const minutes = Math.max(0, Math.ceil((instant - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  const units = moonModuleCatalog[language].durationUnits;
  return [
    ...(days === 0 ? [] : [`${String(days)} ${days === 1 ? units.day : units.days}`]),
    ...(remainingHours === 0 ? [] : [`${String(remainingHours)} ${units.hour}`]),
    ...(remainingMinutes === 0 && (days > 0 || remainingHours > 0) ? [] : [`${String(remainingMinutes)} ${units.minute}`]),
  ].join(" ");
};

/** Resolve bilingual phase and local event values without any network dependency. */
export const resolveMoonTemplateValues = (input: {
  location: MoonLocation | null;
  now: number;
  timeZone: string;
  language: ModuleLanguage;
  errorText: string;
  names: readonly string[];
}): ResolvedMoonTemplateValues => {
  const state = calculateMoonState(input.now);
  const phase = moonModuleCatalog[input.language].phases[state.phase] ?? (input.language === "de" ? "Neumond" : "New moon");
  const values: Record<string, string> = {
    "moon.phase": phase,
    "moon.illumination": String(state.illumination),
  };
  const eventNames = input.names.some((name) => name === "moon.rise" || name === "moon.set" || name === "moon.rise_in" || name === "moon.set_in");
  if (eventNames) {
    if (input.location === null) {
      for (const name of ["moon.rise", "moon.set", "moon.rise_in", "moon.set_in"]) values[name] = input.errorText;
    } else {
      const events = nextMoonEvents(input.location, input.now);
      const rise = events.riseAts[0] === undefined ? null : Date.parse(events.riseAts[0]);
      const set = events.setAts[0] === undefined ? null : Date.parse(events.setAts[0]);
      values["moon.rise"] = rise === null ? input.errorText : formatMoonTime(rise, input.timeZone, input.language);
      values["moon.set"] = set === null ? input.errorText : formatMoonTime(set, input.timeZone, input.language);
      values["moon.rise_in"] = rise === null ? input.errorText : formatDuration(rise, input.now, input.language);
      values["moon.set_in"] = set === null ? input.errorText : formatDuration(set, input.now, input.language);
    }
  }
  return { values, illumination: state.illumination, phase };
};
