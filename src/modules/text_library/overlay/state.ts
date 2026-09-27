import type { JsonObject, ModuleOverlayElementContext } from "../../contract";
import { OVERLAY_STREAM_DETAILS_CACHE_TTL_MS } from "../../contract";
import type { TextBlock, TextBlockConditions, TwitchGame } from "../contracts";
import { TEXT_BLOCK_NAME_PATTERN } from "../contracts";
import { blockReferencesInText, nextTextBlockLocalMidnight, textBlockConditionSwitchTimes } from "../domain";
import { renderOverlayTextPreservingDynamicValues } from "./render";

interface BlockRow {
  block_name: string;
  games_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  variant_id: string;
  position: number;
  conditions_json: string;
  texts_json: string;
}

const parseJson = <T,>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const loadBlock = async (db: D1Database, channelId: string, name: string): Promise<TextBlock | null> => {
  const row = await db.prepare(
    `SELECT block_name, games_json, revision, created_at, updated_at
       FROM text_blocks WHERE channel_id = ? AND block_name = ?`,
  ).bind(channelId, name).first<BlockRow>();
  if (row === null) return null;
  const variants = await db.prepare(
    `SELECT variant_id, position, conditions_json, texts_json
       FROM text_block_variants WHERE channel_id = ? AND block_name = ? ORDER BY position`,
  ).bind(channelId, name).all<VariantRow>();
  return {
    channelId,
    name: row.block_name,
    categoryId: "",
    games: parseJson<TwitchGame[]>(row.games_json, []),
    variants: variants.results.map((variant) => ({
      id: variant.variant_id,
      conditions: parseJson<TextBlockConditions>(variant.conditions_json, {}),
      texts: parseJson<string[]>(variant.texts_json, []),
    })),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const dataConditionIdsFor = (block: TextBlock): string[] => [...new Set(block.variants.flatMap((variant) =>
  Object.keys(variant.conditions.data ?? {})))];

const referencedBlocksFor = async (
  db: D1Database,
  channelId: string,
  root: TextBlock,
): Promise<TextBlock[]> => {
  const found = new Map([[root.name, root]]);
  let frontier = [root];
  for (let depth = 1; depth < 3 && frontier.length > 0; depth += 1) {
    const names = [...new Set(frontier.flatMap((block) => block.variants.flatMap((variant) =>
      variant.texts.flatMap(blockReferencesInText))))]
      .filter((name) => TEXT_BLOCK_NAME_PATTERN.test(name) && !found.has(name));
    const loaded = await Promise.all(names.map((name) => loadBlock(db, channelId, name)));
    frontier = loaded.filter((block): block is TextBlock => block !== null);
    for (const block of frontier) found.set(block.name, block);
  }
  return [...found.values()];
};

const serverConditionsMatch = (
  conditions: TextBlockConditions,
  stream: "online" | "offline" | "unknown",
  gameId: string | null,
  dataConditions: Readonly<Record<string, string>>,
  timeDependentConditionIds: ReadonlySet<string>,
): boolean => {
  if (conditions.minimumTier !== undefined) return false;
  if (conditions.stream !== undefined && conditions.stream !== stream) return false;
  if (conditions.game !== undefined) {
    const same = gameId === conditions.game.game.id;
    if (conditions.game.mode === "is" ? !same : same) return false;
  }
  for (const [id, value] of Object.entries(conditions.data ?? {})) {
    if (!timeDependentConditionIds.has(id) && dataConditions[id] !== value) return false;
  }
  return true;
};

const timeConditionsFor = (
  conditions: TextBlockConditions,
  timeDependentConditionIds: ReadonlySet<string>,
): TextBlockConditions => {
  const data = Object.fromEntries(Object.entries(conditions.data ?? {}).filter(([id]) => timeDependentConditionIds.has(id)));
  return {
    ...(conditions.weekdays === undefined ? {} : { weekdays: conditions.weekdays }),
    ...(conditions.timeWindow === undefined ? {} : { timeWindow: conditions.timeWindow }),
    ...(Object.keys(data).length === 0 ? {} : { data }),
  };
};

const dynamicNamesIn = (text: string, names: ReadonlySet<string>): string[] => [...new Set(
  [...text.matchAll(/\{([a-z][a-z0-9_.]{0,63})\}/gu)]
    .flatMap((match) => match[1] !== undefined && names.has(match[1]) ? [match[1]] : []),
)];

const templateNamesIn = (texts: readonly string[]): ReadonlySet<string> => new Set(
  texts.flatMap((text) => [...text.matchAll(/\{([a-z][a-z0-9_.]{0,63})\}/gu)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1]])),
);

const candidateText = async (
  source: string,
  context: ModuleOverlayElementContext,
): Promise<{ text: string; countdownTargets: Readonly<Record<string, readonly string[]>> } | null> => {
  const rendered = await renderOverlayTextPreservingDynamicValues(source, context.dynamicTemplateVariableNames, context.renderTemplate);
  if (rendered.text.trim().length === 0) return null;
  const templateNames = dynamicNamesIn(rendered.text, context.overlayTemplateVariableNames);
  const dynamicNames = dynamicNamesIn(rendered.text, context.dynamicTemplateVariableNames);
  const values = await context.resolveOverlayTemplateValues(templateNames);
  if (templateNames.some((name) => values[name]?.available !== true)) return null;
  const countdownTargets: Record<string, readonly string[]> = {};
  for (const name of dynamicNames) {
    const targetAts = values[name]?.targetAts ?? (values[name]?.targetAt === undefined ? [] : [values[name].targetAt]);
    const validTargets = targetAts.filter((target) => Number.isFinite(Date.parse(target)));
    if (validTargets.length > 0) countdownTargets[name] = validTargets;
  }
  return { text: rendered.text, countdownTargets };
};

export const textBlockOverlayState = async (
  db: D1Database,
  channelId: string,
  rawConfig: JsonObject,
  context?: ModuleOverlayElementContext,
): Promise<JsonObject | null> => {
  const name = rawConfig.blockName;
  if (typeof name !== "string" || !TEXT_BLOCK_NAME_PATTERN.test(name) || context === undefined) return null;
  const block = await loadBlock(db, channelId, name);
  if (block === null || block.variants.length === 0) return null;
  const dependencyBlocks = await referencedBlocksFor(db, channelId, block);
  const nestedBlocks = dependencyBlocks.filter((dependency) => dependency.name !== block.name);
  const referencedTemplateNames = templateNamesIn(dependencyBlocks.flatMap((dependency) =>
    dependency.variants.flatMap((variant) => variant.texts)));

  const needsStream = block.variants.some((variant) => variant.conditions.stream !== undefined) ||
    referencedTemplateNames.has("viewers");
  const needsGame = block.games.length > 0 || block.variants.some((variant) => variant.conditions.game !== undefined);
  const [streamState, gameId, timeZone] = await Promise.all([
    needsStream ? context.streamState() : Promise.resolve("unknown" as const),
    needsGame ? context.channelGameId() : Promise.resolve(null),
    context.channelTimeZone(),
  ]);
  if (block.games.length > 0 && (gameId === null || !block.games.some((game) => game.id === gameId))) return null;

  const conditionIds = [...new Set(dependencyBlocks.flatMap(dataConditionIdsFor))];
  const currentDataConditions = await context.resolveTemplateConditions(conditionIds);
  const temporalCandidates: { position: number; conditions: TextBlockConditions; text: string }[] = [];
  let fallbackCandidate: { position: number; conditions: TextBlockConditions; text: string } | null = null;
  const countdownTargets: Record<string, readonly string[]> = {};
  for (const [position, variant] of block.variants.entries()) {
    if (!serverConditionsMatch(variant.conditions, streamState, gameId, currentDataConditions, context.timeDependentTemplateConditionIds)) continue;
    const rawText = variant.texts[0];
    if (rawText === undefined) continue;
    const rendered = await candidateText(rawText, context);
    if (rendered === null) continue;
    Object.assign(countdownTargets, rendered.countdownTargets);
    const timeConditions = timeConditionsFor(variant.conditions, context.timeDependentTemplateConditionIds);
    const candidate = { position, conditions: timeConditions, text: rendered.text };
    if (Object.keys(timeConditions).length === 0) {
      fallbackCandidate ??= candidate;
    } else {
      temporalCandidates.push(candidate);
    }
  }
  const candidates = [
    ...temporalCandidates.filter(({ position }) => fallbackCandidate === null || position < fallbackCandidate.position),
    ...(fallbackCandidate === null ? [] : [fallbackCandidate]),
  ].sort((left, right) => left.position - right.position).map(({ conditions, text }) => ({ conditions, text }));
  if (candidates.length === 0) {
    // No variant currently renders (e.g. a countdown target, such as a polar-night
    // sunrise, has no occurrence in its lookahead window). Still hand back a
    // refreshAt so an already-open overlay re-bootstraps once that may have changed,
    // instead of staying blank forever.
    return {
      serverNow: new Date(context.now).toISOString(),
      timeZone,
      dataConditions: {},
      transitions: [],
      switchTimes: [],
      refreshAt: new Date(context.now + 24 * 60 * 60 * 1_000).toISOString(),
      countdownTargets: {},
      candidates: [],
    };
  }
  const until = context.now + 7 * 24 * 60 * 60 * 1_000;
  const nestedTimeConditions = nestedBlocks.flatMap((dependency) => dependency.variants.map(({ conditions }) => conditions)
    .filter((conditions) => conditions.weekdays !== undefined || conditions.timeWindow !== undefined ||
      Object.keys(conditions.data ?? {}).some((id) => context.timeDependentTemplateConditionIds.has(id))));
  const nestedTimeConditionIds = [...new Set(nestedTimeConditions.flatMap((conditions) =>
    Object.keys(conditions.data ?? {}).filter((id) => context.timeDependentTemplateConditionIds.has(id)),
  ))];
  const timeConditionIds = [...new Set([
    ...candidates.flatMap(({ conditions }) =>
      Object.keys(conditions.data ?? {}).filter((id) => context.timeDependentTemplateConditionIds.has(id)),
    ),
    ...nestedTimeConditionIds,
  ])];
  const transitions = await context.resolveTemplateConditionTransitions(timeConditionIds, context.now, until);
  const nestedTransitionTimes = transitions.flatMap(({ at, values }) =>
    Object.keys(values).some((id) => nestedTimeConditionIds.includes(id)) ? [at] : [],
  );
  const nestedSwitchTimes = [
    ...textBlockConditionSwitchTimes(nestedTimeConditions, timeZone, context.now, until),
    ...nestedTransitionTimes,
  ].filter((at) => Date.parse(at) > context.now && Date.parse(at) <= until);
  const countdownExpiries = Object.values(countdownTargets).flatMap((targets) => targets.map(Date.parse))
    .filter((at) => Number.isFinite(at) && at > context.now);
  const systemRefreshAts: number[] = [];
  if (referencedTemplateNames.has("time") || referencedTemplateNames.has("uptime")) {
    systemRefreshAts.push((Math.floor(context.now / 60_000) + 1) * 60_000);
  }
  if (referencedTemplateNames.has("date")) {
    systemRefreshAts.push(nextTextBlockLocalMidnight(context.now, timeZone));
  }
  if (referencedTemplateNames.has("viewers") && streamState === "online") {
    systemRefreshAts.push(context.now + OVERLAY_STREAM_DETAILS_CACHE_TTL_MS);
  }
  const fixedSunNames = ["sun.set", "sun.rise", "sun.dusk"].filter((name) => referencedTemplateNames.has(name));
  if (fixedSunNames.length > 0) {
    const sunValues = await context.resolveOverlayTemplateValues(fixedSunNames);
    const sunRefreshAts = Object.values(sunValues).flatMap((value) => [
      ...(value.targetAt === undefined ? [] : [value.targetAt]),
      ...(value.targetAts ?? []),
    ]).map(Date.parse).filter((at) => Number.isFinite(at) && at > context.now)
      .map((at) => at + 1_000);
    systemRefreshAts.push(...sunRefreshAts);
  }
  const conditionTimelineRefreshAt = timeConditionIds.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.max(context.now + 1_000, until - 60 * 60 * 1_000);
  const countdownRefreshAt = countdownExpiries.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...countdownExpiries) + 1_000;
  const timelineRefreshAt = Math.min(conditionTimelineRefreshAt, countdownRefreshAt);
  const nestedRefreshAt = nestedSwitchTimes.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.max(context.now + 1_000, Math.min(...nestedSwitchTimes.map((at) => Date.parse(at))) - 5_000);
  const systemRefreshAt = systemRefreshAts.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...systemRefreshAts);
  const refreshAt = Math.min(timelineRefreshAt, nestedRefreshAt, systemRefreshAt);
  const switchTimes = [...new Set([
    ...textBlockConditionSwitchTimes(candidates.map(({ conditions }) => conditions), timeZone, context.now, until),
    ...textBlockConditionSwitchTimes(nestedTimeConditions, timeZone, context.now, until),
    ...transitions.map(({ at }) => at).filter((at) => Date.parse(at) > context.now && Date.parse(at) <= until),
  ])].sort((left, right) => Date.parse(left) - Date.parse(right));

  return {
    serverNow: new Date(context.now).toISOString(),
    timeZone,
    dataConditions: Object.fromEntries(timeConditionIds.flatMap((id) => currentDataConditions[id] === undefined ? [] : [[id, currentDataConditions[id]]])),
    transitions: transitions.map((transition) => ({ at: transition.at, values: transition.values })),
    switchTimes,
    ...(Number.isFinite(refreshAt) ? { refreshAt: new Date(refreshAt).toISOString() } : {}),
    countdownTargets,
    candidates,
  } as unknown as JsonObject;
};
