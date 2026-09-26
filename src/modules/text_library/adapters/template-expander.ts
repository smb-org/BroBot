import type { ModuleChatStatus, ModuleStreamState, TemplateContext } from "../../contract";
import type { TextBlock, TextBlockVariant, TwitchGame } from "../contracts";
import { blockReferencesInText, firstMatchingTextBlockVariant, textBlockAppliesToGame, type TextBlockState } from "../domain";

interface BlockRow {
  block_name: string;
  games_json: string;
}

interface VariantRow {
  block_name: string;
  variant_id: string;
  position: number;
  conditions_json: string;
  texts_json: string;
}

export interface TextBlockExpansionContext {
  templateContext: TemplateContext;
  chatStatus: readonly ModuleChatStatus[] | null;
  streamState: () => Promise<ModuleStreamState>;
  currentGame: () => Promise<TwitchGame | null>;
  now: number;
}

export interface TextBlockExpansion {
  text: string;
  used: boolean;
  outputLimit?: number;
}

const parseJson = <T,>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const chunksOf = <T,>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const variantMap = (rows: readonly VariantRow[]): Map<string, TextBlockVariant[]> => {
  const mapped = new Map<string, TextBlockVariant[]>();
  for (const row of rows) {
    const entries = mapped.get(row.block_name) ?? [];
    entries.push({
      id: row.variant_id,
      conditions: parseJson(row.conditions_json, {}),
      texts: parseJson(row.texts_json, []),
    });
    mapped.set(row.block_name, entries);
  }
  return mapped;
};

const EXPANSION_BUDGET = 501;

export const createTextBlockTemplateExpander = (
  db: D1Database,
  channelId: string,
  context: TextBlockExpansionContext,
) => async (text: string, knownVariables: ReadonlySet<string>): Promise<TextBlockExpansion> => {
  const initialReferences = blockReferencesInText(text).filter((name) => !knownVariables.has(name));
  if (initialReferences.length === 0) return { text, used: false };
  const loadBlockRows = async (names: readonly string[]): Promise<BlockRow[]> => {
    if (names.length === 0) return [];
    const chunks = chunksOf(names, 50);
    const results = await Promise.all(chunks.map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return db.prepare(`SELECT block_name, games_json FROM text_blocks WHERE channel_id = ? AND block_name IN (${placeholders})`)
        .bind(channelId, ...chunk).all<BlockRow>();
    }));
    return results.flatMap((result) => result.results);
  };
  const loadVariantRows = async (names: readonly string[]): Promise<VariantRow[]> => {
    if (names.length === 0) return [];
    const chunks = chunksOf(names, 50);
    const results = await Promise.all(chunks.map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return db.prepare(`SELECT block_name, variant_id, position, conditions_json, texts_json FROM text_block_variants WHERE channel_id = ? AND block_name IN (${placeholders}) ORDER BY block_name, position`)
        .bind(channelId, ...chunk).all<VariantRow>();
    }));
    return results.flatMap((result) => result.results);
  };
  const rootRows = await loadBlockRows(initialReferences);
  if (rootRows.length === 0) return { text, used: false };
  const blockRows = new Map(rootRows.map((row) => [row.block_name, row]));
  const allVariantRows: VariantRow[] = [];
  let frontier = rootRows.map((row) => row.block_name);
  for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
    const variantRows = await loadVariantRows(frontier);
    allVariantRows.push(...variantRows);
    const nextReferences = [...new Set(variantRows.flatMap((row) => parseJson<string[]>(row.texts_json, []).flatMap(blockReferencesInText)))]
      .filter((name) => !knownVariables.has(name) && !blockRows.has(name));
    if (depth >= 2 || nextReferences.length === 0) break;
    const nestedRows = await loadBlockRows(nextReferences);
    for (const row of nestedRows) blockRows.set(row.block_name, row);
    frontier = nestedRows.map((row) => row.block_name);
  }
  const variants = variantMap(allVariantRows);
  const blocks = new Map<string, TextBlock>();
  for (const row of blockRows.values()) {
    blocks.set(row.block_name, {
      channelId,
      name: row.block_name,
      categoryId: "",
      games: parseJson<TwitchGame[]>(row.games_json, []),
      variants: variants.get(row.block_name) ?? [],
      revision: 1,
      createdAt: "",
      updatedAt: "",
    });
  }
  const needsTimeZone = [...blocks.values()].some((block) => block.variants.some((variant) => variant.conditions.weekdays !== undefined || variant.conditions.timeWindow !== undefined));
  const settingsRow = needsTimeZone
    ? await db.prepare("SELECT time_zone FROM text_library_settings WHERE channel_id = ?").bind(channelId).first<{ time_zone: string }>()
    : null;
  const timeZone = settingsRow?.time_zone ?? "Europe/Berlin";
  const needsStream = [...blocks.values()].some((block) => block.variants.some((variant) => variant.conditions.stream !== undefined));
  const needsGame = [...blocks.values()].some((block) => block.games.length > 0 || block.variants.some((variant) => variant.conditions.game !== undefined));
  const persistChoice = async (name: string, variantId: string, length: number): Promise<number> => {
    const row = await db.prepare(
      `UPDATE text_block_variants SET last_chosen_index = CASE
         WHEN ? <= 1 THEN 0
         WHEN last_chosen_index >= 0 AND last_chosen_index < ?
           THEN (last_chosen_index + 1 + abs(random() % (? - 1))) % ?
         ELSE abs(random() % ?)
       END
       WHERE channel_id = ? AND block_name = ? AND variant_id = ? RETURNING last_chosen_index`,
    ).bind(length, length, length, length, length, channelId, name, variantId).first<{ last_chosen_index: number }>();
    return row?.last_chosen_index ?? 0;
  };
  const selectedTextByVariant = new Map<string, Promise<string>>();
  let streamState: ModuleStreamState | undefined;
  let currentGame: TwitchGame | null | undefined;
  const state = async (): Promise<TextBlockState> => {
    if (needsStream && streamState === undefined) streamState = await context.streamState();
    if (needsGame && currentGame === undefined) currentGame = await context.currentGame();
    return {
      streamState: streamState ?? "unknown",
      game: currentGame ?? null,
      chatStatus: context.chatStatus,
      commandContext: context.templateContext === "chat_command",
      timeZone,
      now: context.now,
    };
  };
  const expand = async (
    source: string,
    ancestry: readonly string[],
    budget: number,
  ): Promise<{ text: string; complete: boolean }> => {
    if (budget <= 0) return { text: "", complete: source.length === 0 };
    const tokens = [...source.matchAll(/\{([a-z0-9_]{1,32})\}/gu)];
    if (tokens.length === 0) return { text: source.slice(0, budget), complete: source.length <= budget };
    const currentState = await state();
    let offset = 0;
    let result = "";
    const append = (value: string): boolean => {
      const remaining = budget - result.length;
      result += value.slice(0, remaining);
      return value.length <= remaining;
    };
    for (const token of tokens) {
      const name = token[1];
      const start = token.index;
      if (name === undefined || knownVariables.has(name) || ancestry.includes(name) || ancestry.length >= 3) continue;
      const block = blocks.get(name);
      if (block === undefined) continue;
      if (!append(source.slice(offset, start))) return { text: result, complete: false };
      if (!textBlockAppliesToGame(block, currentState.game?.id ?? null)) {
        offset = start + token[0].length;
        continue;
      }
      const selected = firstMatchingTextBlockVariant(block.variants, currentState);
      if (selected === null) {
        offset = start + token[0].length;
        continue;
      }
      const selectionKey = `${name}\u0000${selected.id}`;
      let selectedTextPromise = selectedTextByVariant.get(selectionKey);
      if (selectedTextPromise === undefined) {
        selectedTextPromise = (async () => {
          const index = await persistChoice(name, selected.id, selected.texts.length);
          return selected.texts[index] ?? selected.texts[0] ?? "";
        })();
        selectedTextByVariant.set(selectionKey, selectedTextPromise);
      }
      const selectedText = await selectedTextPromise;
      const expandedSelection = await expand(selectedText, [...ancestry, name], budget - result.length);
      if (!append(expandedSelection.text) || !expandedSelection.complete) return { text: result, complete: false };
      offset = start + token[0].length;
    }
    if (offset === 0) return { text: source.slice(0, budget), complete: source.length <= budget };
    const complete = append(source.slice(offset));
    return { text: result, complete };
  };

  const expanded = await expand(text, [], EXPANSION_BUDGET);
  return { text: expanded.text, used: true, outputLimit: 500 };
};
