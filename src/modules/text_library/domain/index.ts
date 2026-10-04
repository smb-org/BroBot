import type { ModuleChatStatus, ModuleStreamState } from "../../contract";
import { MODULE_TEMPLATE_TIER_CHAT_STATUSES } from "../../contract";
import type { TextBlock, TextBlockConditions, TextBlockVariant, TwitchGame } from "../contracts";
import { TEXT_BLOCK_MAXIMUMS, TEXT_BLOCK_NAME_PATTERN } from "../contracts";
import { blockReferencesInText } from "../../contracts/text-block-references";
import { localMidnightInTimeZone, nextLocalMidnightInTimeZone, validChannelTimeZone, wallTimeInstantsInTimeZone } from "../../contract";

export { blockReferencesInText } from "../../contracts/text-block-references";

export interface TextBlockState {
  streamState: ModuleStreamState;
  game: TwitchGame | null;
  chatStatus: readonly ModuleChatStatus[] | null;
  commandContext: boolean;
  timeZone: string;
  now: number;
  dataConditions?: Readonly<Record<string, string>>;
}

export type TextBlockGraphError =
  | { reason: "reference_cycle"; path: readonly string[] }
  | { reason: "reference_depth_exceeded"; path: readonly string[] };

const VALID_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const validTextBlockName = (name: string): boolean => TEXT_BLOCK_NAME_PATTERN.test(name);

export const validTimeZone = validChannelTimeZone;

export const validTextBlockConditions = (conditions: TextBlockConditions): boolean => {
  const stream: unknown = conditions.stream;
  if (stream !== undefined && stream !== "online" && stream !== "offline") return false;
  if (conditions.game !== undefined && (!/^[0-9]+$/u.test(conditions.game.game.id) || conditions.game.game.name.trim().length === 0)) return false;
  const gameMode: unknown = conditions.game?.mode;
  if (gameMode !== undefined && gameMode !== "is" && gameMode !== "is_not") return false;
  if (conditions.minimumTier !== undefined && !["everyone", "subscriber", "vip", "moderator", "broadcaster"].includes(conditions.minimumTier)) return false;
  if (conditions.data !== undefined && Object.entries(conditions.data).some(([id, value]) =>
    !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(id) || value.length === 0 || value.length > 32,
  )) return false;
  if (conditions.weekdays !== undefined && (conditions.weekdays.length === 0 || conditions.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return false;
  if (conditions.timeWindow !== undefined && (!VALID_TIME.test(conditions.timeWindow.start) || !VALID_TIME.test(conditions.timeWindow.end))) return false;
  return true;
};

export const validTextBlock = (block: Pick<TextBlock, "name" | "categoryId" | "games" | "variants">): boolean =>
  validTextBlockName(block.name) && block.categoryId.length > 0 &&
  block.games.every((game) => /^[0-9]+$/u.test(game.id) && game.name.trim().length > 0) &&
  block.variants.length >= 1 && block.variants.length <= TEXT_BLOCK_MAXIMUMS.variantsPerBlock &&
  block.variants.every((variant) => variant.id.length > 0 && validTextBlockConditions(variant.conditions) &&
    variant.texts.length >= 1 && variant.texts.length <= TEXT_BLOCK_MAXIMUMS.textsPerVariant &&
    variant.texts.every((text) => text.trim().length > 0 && text.length <= TEXT_BLOCK_MAXIMUMS.textLength)) &&
  block.variants.filter((variant) => Object.keys(variant.conditions).length === 0).length === 1 &&
  Object.keys(block.variants.at(-1)?.conditions ?? {}).length === 0;

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = timeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
};

export const localTimeParts = (now: number, timeZone: string): { weekday: number; minuteOfDay: number } | null => {
  try {
    const parts = formatterFor(timeZone).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday ?? "");
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    return weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)
      ? null
      : { weekday, minuteOfDay: hour * 60 + minute };
  } catch {
    return null;
  }
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

const dateFormatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = dateFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const localDate = (instant: number, timeZone: string): string => {
  const parts = Object.fromEntries(dateFormatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`;
};

const shiftDate = (date: string, amount: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC((year ?? 1970), (month ?? 1) - 1, (day ?? 1) + amount));
  return `${String(shifted.getUTCFullYear())}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
};

/** Returns the next local midnight as a UTC instant for a channel time zone. */
export const nextTextBlockLocalMidnight = (from: number, timeZone: string): number => {
  try {
    return nextLocalMidnightInTimeZone(from, timeZone);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Returns the instant `timeZone`'s UTC offset changes on local calendar date `date`, or
 * null if it doesn't change that day. Brackets the search with that date's own local
 * midnights, which `localMidnightInTimeZone` already resolves correctly regardless of a
 * DST change at midnight itself.
 */
const dayTransitionFormatters = new Map<string, Intl.DateTimeFormat>();

const dayTransitionFormatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = dayTransitionFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dayTransitionFormatters.set(timeZone, formatter);
  }
  return formatter;
};

const dayZoneTransition = (date: string, timeZone: string): number | null => {
  const dayStart = Date.parse(localMidnightInTimeZone(date, timeZone)) + 1;
  const dayEnd = Date.parse(localMidnightInTimeZone(shiftDate(date, 1), timeZone)) - 1;
  const formatter = dayTransitionFormatterFor(timeZone);
  // Intl only resolves to whole seconds, so probe on second boundaries -- otherwise a
  // sub-second remainder leaks into the offset and breaks the binary search below.
  const offsetAt = (instant: number): number => {
    const flooredSecond = Math.floor(instant / 1000) * 1000;
    const parts = Object.fromEntries(formatter.formatToParts(flooredSecond).map((part) => [part.type, part.value]));
    const wallClock = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return wallClock - flooredSecond;
  };
  const offsetStart = offsetAt(dayStart);
  // Cheap check first: most days have no DST transition, so the offset at the day's
  // start and end already match and the binary search below can be skipped entirely.
  if (offsetAt(dayEnd) === offsetStart) return null;
  let low = dayStart;
  let high = dayEnd;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (offsetAt(mid) === offsetStart) low = mid; else high = mid;
  }
  return high;
};

const timeWindowMatches = (conditions: Pick<TextBlockConditions, "weekdays" | "timeWindow">, current: { weekday: number; minuteOfDay: number }): boolean => {
  const weekdays = conditions.weekdays;
  const window = conditions.timeWindow;
  const todayAllowed = weekdays === undefined || weekdays.includes(current.weekday);
  if (window === undefined) return todayAllowed;
  const start = Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3));
  const end = Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3));
  if (start === end) return todayAllowed;
  if (start < end) return todayAllowed && current.minuteOfDay >= start && current.minuteOfDay < end;
  if (current.minuteOfDay >= start) return todayAllowed;
  const previousWeekday = (current.weekday + 6) % 7;
  return current.minuteOfDay < end && (weekdays === undefined || weekdays.includes(previousWeekday));
};

/** Local clock boundaries delivered with overlay candidates for browser-side time switching. */
export const textBlockConditionSwitchTimes = (
  conditions: readonly Pick<TextBlockConditions, "weekdays" | "timeWindow">[],
  timeZone: string,
  from: number,
  until: number,
): readonly string[] => {
  if (!conditions.some((condition) => condition.weekdays !== undefined || condition.timeWindow !== undefined)) return [];
  const switches = new Set<string>();
  const first = shiftDate(localDate(from, timeZone), -1);
  const last = shiftDate(localDate(until, timeZone), 1);
  for (let date = first, guard = 0; date <= last && guard < 12; date = shiftDate(date, 1), guard += 1) {
    const needsTransitionCheck = conditions.some((condition) => condition.timeWindow !== undefined);
    const transition = needsTransitionCheck ? dayZoneTransition(date, timeZone) : null;
    for (const condition of conditions) {
      if (condition.weekdays !== undefined) {
        const midnight = Date.parse(localMidnightInTimeZone(date, timeZone));
        if (midnight > from && midnight <= until) switches.add(new Date(midnight).toISOString());
      }
      if (condition.timeWindow !== undefined) {
        for (const time of [condition.timeWindow.start, condition.timeWindow.end]) {
          for (const instant of wallTimeInstantsInTimeZone(date, time, timeZone)) {
            if (instant > from && instant <= until) switches.add(new Date(instant).toISOString());
          }
        }
        // A DST fall-back replays an hour of wall-clock time, which can flip this
        // window's active state at the transition itself (not just at its start/end
        // wall time) if that boundary falls inside the replayed hour. Add the
        // transition only when it actually flips this specific condition.
        if (transition !== null && transition > from && transition <= until) {
          const before = localTimeParts(transition - 1, timeZone);
          const after = localTimeParts(transition, timeZone);
          if (before !== null && after !== null && timeWindowMatches(condition, before) !== timeWindowMatches(condition, after)) {
            switches.add(new Date(transition).toISOString());
          }
        }
      }
    }
  }
  return [...switches].sort((left, right) => Date.parse(left) - Date.parse(right));
};

export const textBlockTimeConditionsMatch = (
  conditions: Pick<TextBlockConditions, "weekdays" | "timeWindow" | "data">,
  state: { now: number; timeZone: string; dataConditions: Readonly<Record<string, string>> },
): boolean => {
  if (conditions.data !== undefined && Object.entries(conditions.data).some(([id, value]) => state.dataConditions[id] !== value)) return false;
  if (conditions.weekdays === undefined && conditions.timeWindow === undefined) return true;
  const local = localTimeParts(state.now, state.timeZone);
  return local !== null && timeWindowMatches(conditions, local);
};

export const textBlockConditionsMatch = (conditions: TextBlockConditions, state: TextBlockState): boolean => {
  if (conditions.stream !== undefined && state.streamState !== conditions.stream) return false;
  if (conditions.game !== undefined) {
    const same = state.game?.id === conditions.game.game.id;
    if (conditions.game.mode === "is" ? !same : same) return false;
  }
  if (conditions.minimumTier !== undefined) {
    if (!state.commandContext || state.chatStatus === null || state.chatStatus.length === 0) return false;
    const minimumTier = conditions.minimumTier;
    if (!state.chatStatus.some((status) => MODULE_TEMPLATE_TIER_CHAT_STATUSES[minimumTier].includes(status))) return false;
  }
  if (conditions.data !== undefined && Object.entries(conditions.data).some(([id, value]) => state.dataConditions?.[id] !== value)) return false;
  if (conditions.weekdays !== undefined || conditions.timeWindow !== undefined) {
    const local = localTimeParts(state.now, state.timeZone);
    if (local === null || !timeWindowMatches(conditions, local)) return false;
  }
  return true;
};

export const firstMatchingTextBlockVariant = (variants: readonly TextBlockVariant[], state: TextBlockState): TextBlockVariant | null =>
  variants.find((variant) => textBlockConditionsMatch(variant.conditions, state)) ?? null;

export const textBlockAppliesToGame = (block: Pick<TextBlock, "games">, gameId: string | null): boolean =>
  block.games.length === 0 || (gameId !== null && block.games.some((game) => game.id === gameId));

export const validateTextBlockGraph = (
  blocks: ReadonlyMap<string, Pick<TextBlock, "name" | "variants">>,
): TextBlockGraphError | null => {
  const graph = new Map<string, string[]>();
  for (const [name, block] of blocks) {
    graph.set(name, [...new Set(block.variants.flatMap((variant) => variant.texts.flatMap(blockReferencesInText).filter((target) => blocks.has(target))))]);
  }
  const walk = (name: string, path: string[]): TextBlockGraphError | null => {
    if (path.includes(name)) return { reason: "reference_cycle", path: [...path, name] };
    if (path.length >= TEXT_BLOCK_MAXIMUMS.nestingDepth) return { reason: "reference_depth_exceeded", path: [...path, name] };
    const nextPath = [...path, name];
    for (const child of graph.get(name) ?? []) {
      const failure = walk(child, nextPath);
      if (failure !== null) return failure;
    }
    return null;
  };
  for (const name of graph.keys()) {
    const failure = walk(name, []);
    if (failure !== null) return failure;
  }
  return null;
};

export const chooseTextIndex = (length: number, previous: number, randomIndex: (maximumExclusive: number) => number): number => {
  if (length <= 1) return 0;
  const selected = Math.max(0, Math.min(length - 1, randomIndex(length - (previous >= 0 && previous < length ? 1 : 0))));
  return previous >= 0 && previous < length && selected >= previous ? selected + 1 : selected;
};

export const truncateResolvedText = (text: string): { text: string; truncated: boolean } => text.length <= TEXT_BLOCK_MAXIMUMS.renderedLength
  ? { text, truncated: false }
  : { text: `${text.slice(0, TEXT_BLOCK_MAXIMUMS.renderedLength - 1)}…`, truncated: true };
