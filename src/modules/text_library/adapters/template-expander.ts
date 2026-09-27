import type { ModuleTemplateValueContext } from "../../contract";
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
const MAX_EXPANSION_STEPS = 10_000;

/** Resolves each requested block name independently; nested expansion stays inside the library. */
export const createTextBlockTemplateValueProvider = (db: D1Database, channelId: string) => async (
  names: readonly string[],
  context: ModuleTemplateValueContext,
): Promise<Readonly<Record<string, string>>> => {
  const requestedBlocks = [...new Set(names)];
  if (requestedBlocks.length === 0) return {};

  const loadBlockRows = async (blockNames: readonly string[]): Promise<BlockRow[]> => {
    if (blockNames.length === 0) return [];
    const chunks = chunksOf(blockNames, 50);
    const results = await Promise.all(chunks.map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return db.prepare(`SELECT block_name, games_json FROM text_blocks WHERE channel_id = ? AND block_name IN (${placeholders})`)
        .bind(channelId, ...chunk).all<BlockRow>();
    }));
    return results.flatMap((result) => result.results);
  };
  const loadVariantRows = async (blockNames: readonly string[]): Promise<VariantRow[]> => {
    if (blockNames.length === 0) return [];
    const chunks = chunksOf(blockNames, 50);
    const results = await Promise.all(chunks.map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return db.prepare(`SELECT block_name, variant_id, position, conditions_json, texts_json FROM text_block_variants
        WHERE channel_id = ? AND block_name IN (${placeholders}) ORDER BY block_name, position`)
        .bind(channelId, ...chunk).all<VariantRow>();
    }));
    return results.flatMap((result) => result.results);
  };

  const rootRows = await loadBlockRows(requestedBlocks);
  if (rootRows.length === 0) return {};
  const blockRows = new Map(rootRows.map((row) => [row.block_name, row]));
  const allVariantRows: VariantRow[] = [];
  let frontier = rootRows.map((row) => row.block_name);
  for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
    const variantRows = await loadVariantRows(frontier);
    allVariantRows.push(...variantRows);
    const nextReferences = [...new Set(variantRows.flatMap((row) =>
      parseJson<string[]>(row.texts_json, []).flatMap(blockReferencesInText),
    ))].filter((name) => !context.knownTemplateVariableNames.has(name) && !blockRows.has(name));
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

  const needsTimeZone = [...blocks.values()].some((block) => block.variants.some((variant) =>
    variant.conditions.weekdays !== undefined || variant.conditions.timeWindow !== undefined,
  ));
  const timeZone = needsTimeZone ? await context.channelTimeZone() : "UTC";
  const needsStream = [...blocks.values()].some((block) => block.variants.some((variant) => variant.conditions.stream !== undefined));
  const needsGame = [...blocks.values()].some((block) =>
    block.games.length > 0 || block.variants.some((variant) => variant.conditions.game !== undefined),
  );
  const persistChoice = async (name: string, variantId: string, length: number): Promise<number> => {
    if (length <= 1 || context.mode !== "chat") return 0;
    const row = await db.prepare(
      `UPDATE text_block_variants SET last_chosen_index = CASE
         WHEN last_chosen_index >= 0 AND last_chosen_index < ?
           THEN (last_chosen_index + 1 + abs(random() % (? - 1))) % ?
         ELSE abs(random() % ?)
       END
       WHERE channel_id = ? AND block_name = ? AND variant_id = ? RETURNING last_chosen_index`,
    ).bind(length, length, length, length, channelId, name, variantId).first<{ last_chosen_index: number }>();
    return row?.last_chosen_index ?? 0;
  };
  const selectedTextByVariant = new Map<string, Promise<string>>();
  const expandedBlockByPath = new Map<string, Promise<{ text: string; complete: boolean }>>();
  let remainingSteps = MAX_EXPANSION_STEPS;
  let streamState: Awaited<ReturnType<typeof context.streamState>> | undefined;
  let currentGame: TwitchGame | null | undefined;
  const state = async (): Promise<TextBlockState> => {
    if (needsStream && streamState === undefined) streamState = await context.streamState();
    if (needsGame && currentGame === undefined) {
      const gameId = await context.channelGameId?.();
      currentGame = gameId === undefined || gameId === null || gameId.length === 0 ? null : { id: gameId, name: "" };
    }
    return {
      streamState: streamState ?? "unknown",
      game: currentGame ?? null,
      chatStatus: context.chatStatus,
      commandContext: context.templateContext === "chat_command",
      timeZone,
      now: context.now,
    };
  };

  const resolveHostFragment = async (fragment: string): Promise<string> => {
    const rendered = await context.renderTemplate(fragment, context.mode);
    rendered.diagnostics.forEach(context.addDiagnostic);
    return rendered.text;
  };
  const expand = async (
    source: string,
    ancestry: readonly string[],
    budget: number,
  ): Promise<{ text: string; complete: boolean }> => {
    if (budget <= 0) return { text: "", complete: source.length === 0 };
    const tokens = [...source.matchAll(/\{([a-z0-9_]{1,32})\}/gu)];
    if (tokens.length === 0) {
      const resolved = await resolveHostFragment(source);
      return { text: resolved.slice(0, budget), complete: resolved.length <= budget };
    }
    const currentState = await state();
    let offset = 0;
    let result = "";
    const append = (value: string): boolean => {
      const remaining = budget - result.length;
      result += value.slice(0, remaining);
      return value.length <= remaining;
    };
    for (const token of tokens) {
      remainingSteps -= 1;
      if (remainingSteps < 0) return { text: result, complete: false };
      const name = token[1];
      const start = token.index;
      if (name === undefined || context.knownTemplateVariableNames.has(name) || ancestry.includes(name) || ancestry.length >= 3) continue;
      const block = blocks.get(name);
      if (block === undefined) continue;
      if (!append(await resolveHostFragment(source.slice(offset, start)))) return { text: result, complete: false };
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
      const childAncestry = [...ancestry, name];
      const expansionKey = childAncestry.join("\u0000");
      let expandedSelectionPromise = expandedBlockByPath.get(expansionKey);
      if (expandedSelectionPromise === undefined) {
        expandedSelectionPromise = expand(selectedText, childAncestry, EXPANSION_BUDGET);
        expandedBlockByPath.set(expansionKey, expandedSelectionPromise);
      }
      const expandedSelection = await expandedSelectionPromise;
      if (!append(expandedSelection.text) || !expandedSelection.complete) return { text: result, complete: false };
      offset = start + token[0].length;
    }
    if (offset === 0) {
      const resolved = await resolveHostFragment(source);
      return { text: resolved.slice(0, budget), complete: resolved.length <= budget };
    }
    const complete = append(await resolveHostFragment(source.slice(offset)));
    return { text: result, complete };
  };

  const values: Record<string, string> = {};
  for (const name of requestedBlocks) {
    if (!blocks.has(name)) continue;
    const currentState = await state();
    const block = blocks.get(name);
    if (block === undefined || !textBlockAppliesToGame(block, currentState.game?.id ?? null)) {
      values[name] = "";
      continue;
    }
    const selected = firstMatchingTextBlockVariant(block.variants, currentState);
    if (selected === null) {
      values[name] = "";
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
    const expanded = await expand(selectedText, [name], EXPANSION_BUDGET);
    if (!expanded.complete || expanded.text.length > 500) {
      context.addDiagnostic({ code: "template_truncated", detail: { current: expanded.text.length } });
      values[name] = `${expanded.text.slice(0, 499)}…`;
    } else {
      values[name] = expanded.text;
    }
  }
  return values;
};
