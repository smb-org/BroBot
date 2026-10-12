import type { AuditAction } from "../../../contracts/values";
import type { AuthorizeModuleMutation, PrepareModuleAudit } from "../../contract";
import type { TextBlock, TextBlockCategory, TextBlockVariant, TextLibrarySettings, TextBlockUsage, TwitchGame } from "../contracts";
import { DEFAULT_TEXT_BLOCK_CATEGORIES, TEXT_BLOCK_MAXIMUMS } from "../contracts";
import type { TextBlockRenameInput, TextBlockRepository, TextLibrarySnapshot } from "../repository";
import type { ModuleTemplateUsageSource } from "../../contract";
import { blockReferencesInText } from "../domain";
import { templateTextLength } from "../../../contracts/template-text-length";

const MODULE_ID = "text_library";

interface BlockRow {
  channel_id: string;
  block_name: string;
  category_id: string;
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

interface CategoryRow {
  category_id: string;
  catalog_key: TextBlockCategory["catalogKey"];
  custom_name: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  revision: number;
  graph_revision: number;
  updated_at: string;
}

const initialBlockRevision = (createdAt: string): number => {
  const timestamp = Date.parse(createdAt);
  return Number.isSafeInteger(timestamp) && timestamp >= 1 ? timestamp : 1;
};

export const blockUsageExistsSql = `(
  EXISTS (SELECT 1 FROM text_block_variants AS variant
           WHERE variant.channel_id = ? AND instr(variant.texts_json, ?) > 0)
  OR EXISTS (SELECT 1 FROM timers AS timer
              WHERE timer.channel_id = ? AND instr(timer.message_text, ?) > 0)
  OR EXISTS (SELECT 1 FROM faq_entries AS faq
              WHERE faq.channel_id = ? AND instr(faq.answer_text, ?) > 0)
  OR EXISTS (SELECT 1 FROM text_commands AS command
              WHERE command.channel_id = ? AND (
                instr(command.response_text, ?) > 0 OR instr(command.template_fields_json, ?) > 0 OR
                instr(command.timeout_fallback_text, ?) > 0 OR instr(command.timeout_reason, ?) > 0))
  OR EXISTS (SELECT 1 FROM channel_modules AS module
              WHERE module.channel_id = ? AND instr(module.settings, ?) > 0)
  OR EXISTS (SELECT 1 FROM overlay_elements AS element
              WHERE element.channel_id = ? AND (
                instr(element.text, ?) > 0 OR instr(element.config_json, ?) > 0 OR
                (element.kind = 'text_library.block' AND json_extract(element.config_json, '$.blockName') = ?)))
)`;

const blockUsageValues = (channelId: string, name: string): string[] => {
  const token = `{text.${name}}`;
  return [
    channelId, token,
    channelId, token,
    channelId, token,
    channelId, token, token, token, token,
    channelId, token,
    channelId, token, token, name,
  ];
};

const parseJson = <T,>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const mapVariant = (row: VariantRow): TextBlockVariant => ({
  id: row.variant_id,
  conditions: parseJson(row.conditions_json, {}),
  texts: parseJson(row.texts_json, []),
});

const mapCategory = (row: CategoryRow): TextBlockCategory => ({
  id: row.category_id,
  catalogKey: row.catalog_key,
  customName: row.custom_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapSettings = (row: SettingsRow): TextLibrarySettings => ({
  revision: row.revision,
  graphRevision: row.graph_revision,
  updatedAt: row.updated_at,
});

const stringsFromJson = (raw: string): string[] => {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return []; }
  const visit = (entry: unknown): string[] => {
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry)) return entry.flatMap(visit);
    if (typeof entry === "object" && entry !== null) return Object.values(entry).flatMap(visit);
    return [];
  };
  return visit(value);
};

const textBlockRenameWouldOverflow = async (db: D1Database, channelId: string, from: string, to: string): Promise<boolean> => {
  const oldToken = `{text.${from}}`;
  const nextToken = `{text.${to}}`;
  const [variants, commands, timers, faqEntries, modules, overlayElements] = await Promise.all([
    db.prepare("SELECT texts_json FROM text_block_variants WHERE channel_id = ? AND instr(texts_json, ?) > 0")
      .bind(channelId, oldToken).all<{ texts_json: string }>(),
    db.prepare(`SELECT response_text, template_fields_json, timeout_fallback_text, timeout_reason
                  FROM text_commands WHERE channel_id = ? AND (
                    instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0 OR
                    instr(COALESCE(timeout_fallback_text, ''), ?) > 0 OR instr(COALESCE(timeout_reason, ''), ?) > 0
                  )`).bind(channelId, oldToken, oldToken, oldToken, oldToken)
      .all<{ response_text: string; template_fields_json: string; timeout_fallback_text: string | null; timeout_reason: string | null }>(),
    db.prepare("SELECT message_text FROM timers WHERE channel_id = ? AND instr(message_text, ?) > 0")
      .bind(channelId, oldToken).all<{ message_text: string }>(),
    db.prepare("SELECT answer_text FROM faq_entries WHERE channel_id = ? AND instr(answer_text, ?) > 0")
      .bind(channelId, oldToken).all<{ answer_text: string }>(),
    db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND instr(settings, ?) > 0")
      .bind(channelId, oldToken).all<{ settings: string }>(),
    db.prepare("SELECT text, config_json FROM overlay_elements WHERE channel_id = ? AND (instr(text, ?) > 0 OR instr(config_json, ?) > 0)")
      .bind(channelId, oldToken, oldToken).all<{ text: string; config_json: string }>(),
  ]);
  const templateTexts = [
    ...variants.results.flatMap((row) => stringsFromJson(row.texts_json)),
    ...commands.results.flatMap((row) => [
      row.response_text,
      ...stringsFromJson(row.template_fields_json),
      ...(row.timeout_fallback_text === null ? [] : [row.timeout_fallback_text]),
      ...(row.timeout_reason === null ? [] : [row.timeout_reason]),
    ]),
    ...timers.results.map((row) => row.message_text),
    ...faqEntries.results.map((row) => row.answer_text),
    ...modules.results.flatMap((row) => stringsFromJson(row.settings)),
  ];
  if (templateTexts.some((text) => text.includes(oldToken) && templateTextLength(text.replaceAll(oldToken, nextToken)) > 500)) return true;
  return overlayElements.results.some((row) =>
    (row.text.includes(oldToken) && row.text.replaceAll(oldToken, nextToken).length > 100) ||
    new TextEncoder().encode(row.config_json.replaceAll(oldToken, nextToken)).byteLength > 4_096,
  );
};

const channelLibraryRevision = async (db: D1Database, channelId: string): Promise<number> =>
  (await db.prepare("SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'channel.library'")
    .bind(channelId).first<{ revision: number }>())?.revision ?? 0;

export const textBlockSelectColumns = `channel_id, block_name, category_id, games_json,
                     revision, created_at, updated_at`;
export const textBlockCategorySelectColumns = `category_id, catalog_key, custom_name, created_at, updated_at`;

export const createTextBlockRepository = (
  db: D1Database,
  authorizeMutation: AuthorizeModuleMutation,
  prepareModuleAudit?: PrepareModuleAudit,
): TextBlockRepository => {
  const find = async (channelId: string, name: string): Promise<TextBlock | null> => {
    const row = await db.prepare(`SELECT ${textBlockSelectColumns} FROM text_blocks WHERE channel_id = ? AND block_name = ?`)
      .bind(channelId, name).first<BlockRow>();
    if (row === null) return null;
    const variants = await db.prepare(
      `SELECT variant_id, position, conditions_json, texts_json FROM text_block_variants
        WHERE channel_id = ? AND block_name = ? ORDER BY position`,
    ).bind(channelId, name).all<VariantRow>();
    return {
      channelId: row.channel_id,
      name: row.block_name,
      categoryId: row.category_id,
      games: parseJson<TwitchGame[]>(row.games_json, []),
      variants: variants.results.map(mapVariant),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const list = async (channelId: string, usageSources: readonly ModuleTemplateUsageSource[] = []): Promise<TextLibrarySnapshot> => {
    const [blockRows, categoryRows, settingsRow] = await Promise.all([
      db.prepare(`SELECT ${textBlockSelectColumns} FROM text_blocks WHERE channel_id = ? ORDER BY block_name`).bind(channelId).all<BlockRow>(),
      db.prepare(`SELECT ${textBlockCategorySelectColumns} FROM text_library_categories WHERE channel_id = ? ORDER BY catalog_key IS NULL, catalog_key, custom_name, category_id`).bind(channelId).all<CategoryRow>(),
      db.prepare("SELECT revision, graph_revision, updated_at FROM text_library_settings WHERE channel_id = ?").bind(channelId).first<SettingsRow>(),
    ]);
    const variantRows: { results: Array<VariantRow & { block_name: string }> } = blockRows.results.length === 0 ? { results: [] } : await db.prepare(
      `SELECT variant_id, block_name, position, conditions_json, texts_json FROM text_block_variants
        WHERE channel_id = ? ORDER BY block_name, position`,
    ).bind(channelId).all<VariantRow & { block_name: string }>();
    const variantsByName = new Map<string, TextBlockVariant[]>();
    for (const row of variantRows.results) {
      const variants = variantsByName.get(row.block_name) ?? [];
      variants.push(mapVariant(row));
      variantsByName.set(row.block_name, variants);
    }
    const blocks = blockRows.results.map((row): TextBlock => ({
      channelId,
      name: row.block_name,
      categoryId: row.category_id,
      games: parseJson<TwitchGame[]>(row.games_json, []),
      variants: variantsByName.get(row.block_name) ?? [],
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const usages: Record<string, TextBlockUsage[]> = Object.fromEntries(blocks.map((block) => [block.name, []]));
    const blocksByName = new Map(blocks.map((block) => [block.name, block]));
    for (const parent of blocks) {
      const nestedNames = parent.variants.flatMap((variant) => variant.texts.flatMap(blockReferencesInText));
      for (const name of nestedNames) {
        if (!blocksByName.has(name)) continue;
        if (usages[name]?.some((item) => item.kind === "block" && item.label === parent.name) !== true) {
          usages[name]?.push({ kind: "block", label: parent.name });
        }
      }
    }
    for (const source of usageSources) {
      const pending = blockReferencesInText(source.text).filter((name) => blocksByName.has(name));
      const visited = new Set<string>();
      while (pending.length > 0) {
        const name = pending.pop();
        if (name === undefined || visited.has(name)) continue;
        visited.add(name);
        if (usages[name]?.some((item) => item.kind === source.kind && item.label === source.label) !== true) {
          usages[name]?.push({ kind: source.kind, label: source.label });
        }
        for (const text of blocksByName.get(name)?.variants.flatMap((variant) => variant.texts) ?? []) {
          for (const nestedName of blockReferencesInText(text)) {
            if (!visited.has(nestedName) && blocksByName.has(nestedName)) pending.push(nestedName);
          }
        }
      }
    }
    const defaultCategoryTimestamp = settingsRow?.updated_at ?? "1970-01-01T00:00:00.000Z";
    const categoriesById = new Map(categoryRows.results.map((row) => [row.category_id, mapCategory(row)]));
    const categories = [
      ...DEFAULT_TEXT_BLOCK_CATEGORIES.map((category) => categoriesById.get(category.id) ?? {
        id: category.id,
        catalogKey: category.catalogKey,
        customName: null,
        createdAt: defaultCategoryTimestamp,
        updatedAt: defaultCategoryTimestamp,
      }),
      ...categoryRows.results.filter((row) => row.catalog_key === null).map(mapCategory),
    ];
    return {
      blocks,
      categories,
      settings: settingsRow === null ? { revision: 1, graphRevision: 1, updatedAt: new Date().toISOString() } : mapSettings(settingsRow),
      usages,
    };
  };

  const repository: TextBlockRepository = {
    async initialize(channelId, actor, now) {
      const authorization = authorizeMutation(channelId, actor, now);
      const statements = [db.prepare(
        `INSERT OR IGNORE INTO text_library_settings (channel_id, revision, updated_at)
         SELECT ?, 1, ? WHERE 1 = 1 ${authorization.sql}`,
      ).bind(channelId, now, ...authorization.values)];
      for (const category of DEFAULT_TEXT_BLOCK_CATEGORIES) {
        statements.push(db.prepare(
          `INSERT OR IGNORE INTO text_library_categories (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
           SELECT ?, ?, ?, NULL, ?, ? WHERE 1 = 1 ${authorization.sql}`,
        ).bind(channelId, category.id, category.catalogKey, now, now, ...authorization.values));
      }
      await db.batch(statements);
    },
    list,
    find,
    async create(input, actor) {
      await repository.initialize(input.channelId, actor, input.now);
      const authorization = authorizeMutation(input.channelId, actor, input.now);
      const revision = initialBlockRevision(input.now);
      const advanceGraph = db.prepare(
        `UPDATE text_library_settings SET graph_revision = graph_revision + 1
          WHERE channel_id = ? AND graph_revision = ?
            AND (SELECT COUNT(*) FROM text_blocks WHERE channel_id = ?) < ?
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            AND NOT EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ?)
            ${authorization.sql}`,
      ).bind(input.channelId, input.expectedGraphRevision, input.channelId, TEXT_BLOCK_MAXIMUMS.blocksPerChannel,
        input.channelId, input.categoryId, input.channelId, input.name, ...authorization.values);
      const mutation = db.prepare(
        `INSERT INTO text_blocks (channel_id, block_name, category_id, games_json, revision, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE changes() > 0
            AND (SELECT COUNT(*) FROM text_blocks WHERE channel_id = ?) < ?
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            AND NOT EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ?)
            ${authorization.sql}`,
      ).bind(input.channelId, input.name, input.categoryId, JSON.stringify(input.games), revision, input.now, input.now,
        input.channelId, TEXT_BLOCK_MAXIMUMS.blocksPerChannel, input.channelId, input.categoryId, input.channelId, input.name,
        ...authorization.values);
      const variantWrites = input.variants.map((variant, position) => db.prepare(
        `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      ).bind(input.channelId, input.name, variant.id, position, JSON.stringify(variant.conditions), JSON.stringify(variant.texts)));
      const audit = prepareModuleAudit?.({ channelId: input.channelId, moduleId: MODULE_ID, action: "text_library.block.created" satisfies AuditAction, before: null, after: { name: input.name, categoryId: input.categoryId } }, input.now);
      const results = await db.batch([advanceGraph, mutation, ...(audit === undefined ? [] : [audit]), ...variantWrites]);
      const changes = results[1]?.meta.changes ?? 0;
      if (changes > 0) {
        const block = await find(input.channelId, input.name);
        return block === null ? { ok: false, reason: "invalid_block" } : { ok: true, block };
      }
      if (await find(input.channelId, input.name) !== null) return { ok: false, reason: "already_exists" };
      const category = await db.prepare("SELECT 1 AS present FROM text_library_categories WHERE channel_id = ? AND category_id = ?")
        .bind(input.channelId, input.categoryId).first();
      if (category === null) return { ok: false, reason: "category_not_found" };
      const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
        .bind(input.channelId).first<{ graph_revision: number }>();
      if (settings?.graph_revision !== input.expectedGraphRevision) return { ok: false, reason: "conflict" };
      const count = await db.prepare("SELECT COUNT(*) AS count FROM text_blocks WHERE channel_id = ?")
        .bind(input.channelId).first<{ count: number }>();
      return (count?.count ?? 0) >= TEXT_BLOCK_MAXIMUMS.blocksPerChannel
        ? { ok: false, reason: "limit_reached" }
        : { ok: false, reason: "not_authorized" };
    },
    async change(input, actor) {
      const before = await find(input.channelId, input.name);
      if (before === null) return { ok: false, reason: "not_found" };
      if (input.expectedRevision !== before.revision) return { ok: false, reason: "conflict", current: before };
      const authorization = authorizeMutation(input.channelId, actor, input.now);
      const nextRevision = before.revision + 1;
      const advanceGraph = db.prepare(
        `UPDATE text_library_settings SET graph_revision = graph_revision + 1
          WHERE channel_id = ? AND graph_revision = ?
            AND EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ?)
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            ${authorization.sql}`,
      ).bind(input.channelId, input.expectedGraphRevision, input.channelId, input.name, before.revision,
        input.channelId, input.categoryId, ...authorization.values);
      const mutation = db.prepare(
        `UPDATE text_blocks SET category_id = ?, games_json = ?, revision = ?, updated_at = ?
          WHERE channel_id = ? AND block_name = ? AND revision = ?
            AND changes() > 0
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            ${authorization.sql}`,
      ).bind(input.categoryId, JSON.stringify(input.games), nextRevision, input.now, input.channelId, input.name, before.revision,
        input.channelId, input.categoryId, ...authorization.values);
      const audit = prepareModuleAudit?.({
        channelId: input.channelId, moduleId: MODULE_ID, action: "text_library.block.updated" satisfies AuditAction,
        before: { name: before.name, categoryId: before.categoryId, variantCount: before.variants.length },
        after: { name: before.name, categoryId: input.categoryId, variantCount: input.variants.length },
      }, input.now);
      const removeVariants = db.prepare("DELETE FROM text_block_variants WHERE channel_id = ? AND block_name = ? AND changes() > 0")
        .bind(input.channelId, input.name);
      const variantWrites = input.variants.map((variant, position) => db.prepare(
        `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
      ).bind(input.channelId, input.name, variant.id, position, JSON.stringify(variant.conditions), JSON.stringify(variant.texts)));
      const results = await db.batch([advanceGraph, mutation, ...(audit === undefined ? [] : [audit]), removeVariants, ...variantWrites]);
      if ((results[1]?.meta.changes ?? 0) === 0) {
        const current = await find(input.channelId, input.name);
        if (current === null) return { ok: false, reason: "not_found" };
        const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
          .bind(input.channelId).first<{ graph_revision: number }>();
        return { ok: false, reason: settings?.graph_revision === input.expectedGraphRevision ? "not_authorized" : "conflict", current };
      }
      const block = await find(input.channelId, input.name);
      return block === null ? { ok: false, reason: "invalid_block" } : { ok: true, block };
    },
    async rename(input: TextBlockRenameInput, fromName, actor) {
      const before = await find(input.channelId, fromName);
      if (before === null) {
        const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
          .bind(input.channelId).first<{ graph_revision: number }>();
        return { ok: false, reason: settings?.graph_revision === input.expectedGraphRevision ? "not_found" : "conflict" };
      }
      if (before.revision !== input.expectedRevision) return { ok: false, reason: "conflict", current: before };
      if (await find(input.channelId, input.name) !== null) return { ok: false, reason: "already_exists" };
      const startLibraryRevision = await channelLibraryRevision(db, input.channelId);
      if (await textBlockRenameWouldOverflow(db, input.channelId, fromName, input.name)) {
        return { ok: false, reason: "template_too_long" };
      }
      const expectedLibraryRevision = await channelLibraryRevision(db, input.channelId);
      if (startLibraryRevision !== expectedLibraryRevision) return { ok: false, reason: "conflict", current: before };
      const authorization = authorizeMutation(input.channelId, actor, input.now);
      const nextRevision = before.revision + 1;
      const renamedBlockGuard = `EXISTS (
        SELECT 1 FROM text_blocks
         WHERE channel_id = ? AND block_name = ? AND revision = ? AND updated_at = ?
      )`;
      const renamedBlockValues = [input.channelId, input.name, nextRevision, input.now];
      const advanceGraph = db.prepare(
        `UPDATE text_library_settings SET graph_revision = graph_revision + 1
          WHERE channel_id = ? AND graph_revision = ?
            AND EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ?)
            AND NOT EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ?)
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            AND COALESCE((SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'channel.library'), 0) = ?
            ${authorization.sql}`,
      ).bind(input.channelId, input.expectedGraphRevision, input.channelId, fromName, before.revision,
        input.channelId, input.name, input.channelId, input.categoryId, input.channelId, expectedLibraryRevision,
        ...authorization.values);
      const mutation = db.prepare(
        `UPDATE text_blocks
            SET block_name = ?, category_id = ?, games_json = ?, revision = ?, updated_at = ?
          WHERE channel_id = ? AND block_name = ? AND revision = ? AND changes() > 0
            AND NOT EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ?)
            AND EXISTS (SELECT 1 FROM text_library_categories WHERE channel_id = ? AND category_id = ?)
            ${authorization.sql}`,
      ).bind(input.name, input.categoryId, JSON.stringify(input.games), nextRevision, input.now,
        input.channelId, fromName, before.revision, input.channelId, input.name, input.channelId, input.categoryId,
        ...authorization.values);
      const audit = prepareModuleAudit?.({
        channelId: input.channelId,
        moduleId: MODULE_ID,
        action: "text_library.block.renamed" satisfies AuditAction,
        before: { name: before.name, categoryId: before.categoryId, variantCount: before.variants.length },
        after: { name: input.name, categoryId: input.categoryId, variantCount: input.variants.length },
      }, input.now);
      const rewriteParentRevisions = db.prepare(
        `UPDATE text_blocks
            SET revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND block_name <> ?
            AND EXISTS (
              SELECT 1 FROM text_block_variants AS variant
               WHERE variant.channel_id = text_blocks.channel_id
                 AND variant.block_name = text_blocks.block_name
                 AND instr(variant.texts_json, ?) > 0
            )
            AND ${renamedBlockGuard}`,
      ).bind(input.now, input.channelId, input.name, `{text.${fromName}}`, ...renamedBlockValues);
      const rewriteVariants = db.prepare(
        `UPDATE text_block_variants
            SET texts_json = replace(texts_json, ?, ?)
          WHERE channel_id = ? AND instr(texts_json, ?) > 0 AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, input.channelId, `{text.${fromName}}`, ...renamedBlockValues);
      const rewriteCommands = db.prepare(
        `UPDATE text_commands
            SET response_text = replace(response_text, ?, ?),
                template_fields_json = replace(template_fields_json, ?, ?),
                timeout_fallback_text = replace(timeout_fallback_text, ?, ?),
                timeout_reason = replace(timeout_reason, ?, ?),
                revision = revision + 1, updated_at = ?
          WHERE channel_id = ?
            AND (instr(response_text, ?) > 0 OR instr(template_fields_json, ?) > 0 OR
                 instr(COALESCE(timeout_fallback_text, ''), ?) > 0 OR instr(COALESCE(timeout_reason, ''), ?) > 0)
            AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, `{text.${fromName}}`, `{text.${input.name}}`,
        `{text.${fromName}}`, `{text.${input.name}}`, `{text.${fromName}}`, `{text.${input.name}}`, input.now,
        input.channelId, `{text.${fromName}}`, `{text.${fromName}}`, `{text.${fromName}}`, `{text.${fromName}}`,
        ...renamedBlockValues);
      const rewriteTimers = db.prepare(
        `UPDATE timers SET message_text = replace(message_text, ?, ?), revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND instr(message_text, ?) > 0 AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, input.now, input.channelId, `{text.${fromName}}`, ...renamedBlockValues);
      const rewriteFaq = db.prepare(
        `UPDATE faq_entries SET answer_text = replace(answer_text, ?, ?), revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND instr(answer_text, ?) > 0 AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, input.now, input.channelId, `{text.${fromName}}`, ...renamedBlockValues);
      const rewriteModuleSettings = db.prepare(
        `UPDATE channel_modules SET settings = replace(settings, ? , ?), revision = revision + 1
          WHERE channel_id = ? AND instr(settings, ?) > 0 AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, input.channelId, `{text.${fromName}}`, ...renamedBlockValues);
      const updateOverlayRevisions = db.prepare(
        `UPDATE overlays SET revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND EXISTS (
            SELECT 1 FROM overlay_elements AS element
             WHERE element.channel_id = overlays.channel_id AND element.overlay_id = overlays.overlay_id
               AND (instr(element.text, ?) > 0 OR instr(element.config_json, ?) > 0 OR
                    (element.kind = 'text_library.block' AND json_extract(element.config_json, '$.blockName') = ?))
          )
            AND ${renamedBlockGuard}
          RETURNING overlay_id, revision`,
      ).bind(input.now, input.channelId, `{text.${fromName}}`, `{text.${fromName}}`, fromName, ...renamedBlockValues);
      const rewriteOverlayElements = db.prepare(
        `UPDATE overlay_elements
            SET text = replace(text, ?, ?),
                config_json = CASE
                  WHEN kind = 'text_library.block' AND json_extract(config_json, '$.blockName') = ?
                    THEN json_set(replace(config_json, ?, ?), '$.blockName', ?)
                  ELSE replace(config_json, ?, ?)
                END
          WHERE channel_id = ?
            AND (instr(text, ?) > 0 OR instr(config_json, ?) > 0 OR
                 (kind = 'text_library.block' AND json_extract(config_json, '$.blockName') = ?))
            AND ${renamedBlockGuard}`,
      ).bind(`{text.${fromName}}`, `{text.${input.name}}`, fromName,
        `{text.${fromName}}`, `{text.${input.name}}`, input.name,
        `{text.${fromName}}`, `{text.${input.name}}`,
        input.channelId, `{text.${fromName}}`, `{text.${fromName}}`, fromName, ...renamedBlockValues);
      const statements = [advanceGraph, mutation];
      if (audit !== undefined) statements.push(audit);
      statements.push(rewriteParentRevisions, rewriteVariants, rewriteCommands, rewriteTimers, rewriteFaq,
        rewriteModuleSettings);
      const overlayUpdateIndex = statements.length;
      statements.push(updateOverlayRevisions, rewriteOverlayElements);
      let results: Awaited<ReturnType<typeof db.batch>>;
      try {
        results = await db.batch(statements);
      } catch (error: unknown) {
        if (await textBlockRenameWouldOverflow(db, input.channelId, fromName, input.name)) {
          return { ok: false, reason: "template_too_long" };
        }
        throw error;
      }
      if ((results[1]?.meta.changes ?? 0) === 0) {
        if (await find(input.channelId, input.name) !== null) return { ok: false, reason: "already_exists" };
        const current = await find(input.channelId, fromName);
        if (current === null) {
          const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
            .bind(input.channelId).first<{ graph_revision: number }>();
          return { ok: false, reason: settings?.graph_revision === input.expectedGraphRevision ? "not_found" : "conflict" };
        }
        if (current.revision !== input.expectedRevision) return { ok: false, reason: "conflict", current };
        const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
          .bind(input.channelId).first<{ graph_revision: number }>();
        const currentLibraryRevision = await channelLibraryRevision(db, input.channelId);
        return {
          ok: false,
          reason: settings?.graph_revision === input.expectedGraphRevision && currentLibraryRevision === expectedLibraryRevision
            ? "not_authorized"
            : "conflict",
          current,
        };
      }
      const block = await find(input.channelId, input.name);
      if (block === null) return { ok: false, reason: "invalid_block" };
      const updatedOverlays: { overlayId: string; revision: number }[] = (results[overlayUpdateIndex]?.results ?? []).flatMap((row: unknown) => {
        if (typeof row !== "object" || row === null) return [];
        const overlayId = "overlay_id" in row ? row.overlay_id : undefined;
        const revision = "revision" in row ? row.revision : undefined;
        return typeof overlayId === "string" && typeof revision === "number" ? [{ overlayId, revision }] : [];
      });
      return { ok: true, block, updatedOverlays };
    },
    async delete(channelId, name, revision, graphRevision, actor, now) {
      const before = await find(channelId, name);
      if (before === null) return { ok: false, reason: "not_found" };
      if (before.revision !== revision) return { ok: false, reason: "conflict", current: before };
      const authorization = authorizeMutation(channelId, actor, now);
      const advanceGraph = db.prepare(
        `UPDATE text_library_settings SET graph_revision = graph_revision + 1
          WHERE channel_id = ? AND graph_revision = ?
            AND EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ?)
            AND NOT ${blockUsageExistsSql}
            ${authorization.sql}`,
      ).bind(channelId, graphRevision, channelId, name, revision, ...blockUsageValues(channelId, name), ...authorization.values);
      const mutation = db.prepare("DELETE FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ? AND changes() > 0 " + authorization.sql)
        .bind(channelId, name, revision, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.block.removed" satisfies AuditAction, before: { name, categoryId: before.categoryId }, after: null }, now);
      const results = await db.batch([advanceGraph, mutation, ...(audit === undefined ? [] : [audit])]);
      const changes = results[1]?.meta.changes ?? 0;
      if (changes > 0) return { ok: true, block: before };
      const current = await find(channelId, name);
      if (current === null) return { ok: false, reason: "not_found" };
      if (current.revision !== revision) return { ok: false, reason: "conflict", current };
      const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
        .bind(channelId).first<{ graph_revision: number }>();
      if (settings?.graph_revision !== graphRevision) return { ok: false, reason: "conflict", current };
      const hasUsage = await db.prepare(`SELECT CASE WHEN ${blockUsageExistsSql} THEN 1 ELSE 0 END AS present`)
        .bind(...blockUsageValues(channelId, name)).first<{ present: number }>();
      if (hasUsage?.present === 1) return { ok: false, reason: "in_use", current };
      return { ok: false, reason: "not_authorized", current };
    },
    async renameCategory(channelId, categoryId, customName, actor, now) {
      const authorization = authorizeMutation(channelId, actor, now);
      const before = await db.prepare(`SELECT ${textBlockCategorySelectColumns} FROM text_library_categories WHERE channel_id = ? AND category_id = ?`).bind(channelId, categoryId).first<CategoryRow>();
      if (before === null) return { ok: false };
      const mutation = db.prepare(
        `UPDATE text_library_categories SET custom_name = ?, updated_at = ? WHERE channel_id = ? AND category_id = ? AND catalog_key IS NULL ${authorization.sql}`,
      ).bind(customName, now, channelId, categoryId, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.category.renamed" satisfies AuditAction, before: { id: categoryId, name: before.custom_name }, after: { id: categoryId, name: customName } }, now);
      const changes = (await db.batch([mutation, ...(audit === undefined ? [] : [audit])]))[0]?.meta.changes ?? 0;
      return { ok: changes > 0 };
    },
    async createCategory(channelId, name, actor, now) {
      await repository.initialize(channelId, actor, now);
      const authorization = authorizeMutation(channelId, actor, now);
      const categoryId = `custom_${crypto.randomUUID().replaceAll("-", "")}`;
      const mutation = db.prepare(
        `INSERT INTO text_library_categories (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
         SELECT ?, ?, NULL, ?, ?, ? WHERE (SELECT COUNT(*) FROM text_library_categories WHERE channel_id = ?) < ? ${authorization.sql}`,
      ).bind(channelId, categoryId, name, now, now, channelId, TEXT_BLOCK_MAXIMUMS.categoriesPerChannel, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.category.created" satisfies AuditAction, before: null, after: { id: categoryId, name } }, now);
      const changes = (await db.batch([mutation, ...(audit === undefined ? [] : [audit])]))[0]?.meta.changes ?? 0;
      if (changes === 0) return null;
      const row = await db.prepare(`SELECT ${textBlockCategorySelectColumns} FROM text_library_categories WHERE channel_id = ? AND category_id = ?`)
        .bind(channelId, categoryId).first<CategoryRow>();
      return row === null ? null : mapCategory(row);
    },
    async deleteCategory(channelId, categoryId, actor, now) {
      const authorization = authorizeMutation(channelId, actor, now);
      const before = await db.prepare(`SELECT ${textBlockCategorySelectColumns} FROM text_library_categories WHERE channel_id = ? AND category_id = ?`)
        .bind(channelId, categoryId).first<CategoryRow>();
      if (before === null) return "not_found";
      const mutation = db.prepare(
        `DELETE FROM text_library_categories WHERE channel_id = ? AND category_id = ?
          AND catalog_key IS NULL
          AND NOT EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND category_id = ?) ${authorization.sql}`,
      ).bind(channelId, categoryId, channelId, categoryId, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.category.removed" satisfies AuditAction, before: { id: categoryId, name: before.custom_name ?? before.catalog_key }, after: null }, now);
      const changes = (await db.batch([mutation, ...(audit === undefined ? [] : [audit])]))[0]?.meta.changes ?? 0;
      if (changes > 0) return "ok";
      const exists = await db.prepare("SELECT 1 AS present FROM text_blocks WHERE channel_id = ? AND category_id = ?").bind(channelId, categoryId).first();
      return exists === null ? "not_found" : "not_empty";
    },
  };
  return repository;
};
