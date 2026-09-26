import type { ModuleChatStatus, ModuleStreamState } from "../../contract";
import { TEXT_COMMAND_TIER_CHAT_STATUSES, type TextCommandMinimumTier } from "../../text_commands/contracts";
import type { TextBlock, TextBlockConditions, TextBlockVariant, TwitchGame } from "../contracts";
import { TEXT_BLOCK_MAXIMUMS, TEXT_BLOCK_NAME_PATTERN } from "../contracts";

export interface TextBlockState {
  streamState: ModuleStreamState;
  game: TwitchGame | null;
  chatStatus: readonly ModuleChatStatus[] | null;
  commandContext: boolean;
  timeZone: string;
  now: number;
}

export type TextBlockGraphError =
  | { reason: "reference_cycle"; path: readonly string[] }
  | { reason: "reference_depth_exceeded"; path: readonly string[] };

const VALID_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export const validTextBlockName = (name: string): boolean => TEXT_BLOCK_NAME_PATTERN.test(name);

export const validTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
};

export const validTextBlockConditions = (conditions: TextBlockConditions): boolean => {
  const stream: unknown = conditions.stream;
  if (stream !== undefined && stream !== "online" && stream !== "offline") return false;
  if (conditions.game !== undefined && (!/^[0-9]+$/u.test(conditions.game.game.id) || conditions.game.game.name.trim().length === 0)) return false;
  const gameMode: unknown = conditions.game?.mode;
  if (gameMode !== undefined && gameMode !== "is" && gameMode !== "is_not") return false;
  if (conditions.minimumTier !== undefined && !["everyone", "subscriber", "vip", "moderator", "broadcaster"].includes(conditions.minimumTier)) return false;
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

const timeWindowMatches = (conditions: TextBlockConditions, current: { weekday: number; minuteOfDay: number }): boolean => {
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

export const textBlockConditionsMatch = (conditions: TextBlockConditions, state: TextBlockState): boolean => {
  if (conditions.stream !== undefined && state.streamState !== conditions.stream) return false;
  if (conditions.game !== undefined) {
    const same = state.game?.id === conditions.game.game.id;
    if (conditions.game.mode === "is" ? !same : same) return false;
  }
  if (conditions.minimumTier !== undefined) {
    if (!state.commandContext || state.chatStatus === null || state.chatStatus.length === 0) return false;
    if (!state.chatStatus.some((status) => TEXT_COMMAND_TIER_CHAT_STATUSES[conditions.minimumTier as TextCommandMinimumTier].includes(status))) return false;
  }
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

export const blockReferencesInText = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))];

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
