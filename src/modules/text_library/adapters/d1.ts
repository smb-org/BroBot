import type { AuditAction } from "../../../contracts/values";
import type { AuthorizeModuleMutation, PrepareModuleAudit } from "../../contract";
import type { TextBlock, TextBlockCategory, TextBlockVariant, TextLibrarySettings, TextBlockUsage, TwitchGame } from "../contracts";
import { DEFAULT_TEXT_BLOCK_CATEGORIES, TEXT_BLOCK_MAXIMUMS } from "../contracts";
import type { TextBlockRepository, TextLibrarySnapshot } from "../repository";
import type { ModuleTemplateUsageSource } from "../../contract";
import { blockReferencesInText } from "../domain";

const MODULE_ID = "text_library";

interface BlockRow {
  channel_id: string;
  block_name: string;
  category_id: string;
  games_json: string;
  last_chosen_index: number;
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
  time_zone: string;
  revision: number;
  graph_revision: number;
  updated_at: string;
}

const initialBlockRevision = (createdAt: string): number => {
  const timestamp = Date.parse(createdAt);
  return Number.isSafeInteger(timestamp) && timestamp >= 1 ? timestamp : 1;
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
  timeZone: row.time_zone,
  revision: row.revision,
  graphRevision: row.graph_revision,
  updatedAt: row.updated_at,
});

export const textBlockSelectColumns = `channel_id, block_name, category_id, games_json, last_chosen_index,
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
      lastChosenIndex: row.last_chosen_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const list = async (channelId: string, usageSources: readonly ModuleTemplateUsageSource[] = []): Promise<TextLibrarySnapshot> => {
    const [blockRows, categoryRows, settingsRow] = await Promise.all([
      db.prepare(`SELECT ${textBlockSelectColumns} FROM text_blocks WHERE channel_id = ? ORDER BY block_name`).bind(channelId).all<BlockRow>(),
      db.prepare(`SELECT ${textBlockCategorySelectColumns} FROM text_library_categories WHERE channel_id = ? ORDER BY catalog_key IS NULL, catalog_key, custom_name, category_id`).bind(channelId).all<CategoryRow>(),
      db.prepare("SELECT time_zone, revision, graph_revision, updated_at FROM text_library_settings WHERE channel_id = ?").bind(channelId).first<SettingsRow>(),
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
      lastChosenIndex: row.last_chosen_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const usages: Record<string, TextBlockUsage[]> = Object.fromEntries(blocks.map((block) => [block.name, []]));
    const blocksByName = new Map(blocks.map((block) => [block.name, block]));
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
      settings: settingsRow === null ? { timeZone: "Europe/Berlin", revision: 1, graphRevision: 1, updatedAt: new Date().toISOString() } : mapSettings(settingsRow),
      usages,
    };
  };

  const repository: TextBlockRepository = {
    async initialize(channelId, now) {
      const statements = [db.prepare(
        "INSERT OR IGNORE INTO text_library_settings (channel_id, time_zone, revision, updated_at) VALUES (?, 'Europe/Berlin', 1, ?)",
      ).bind(channelId, now)];
      for (const category of DEFAULT_TEXT_BLOCK_CATEGORIES) {
        statements.push(db.prepare(
          "INSERT OR IGNORE INTO text_library_categories (channel_id, category_id, catalog_key, custom_name, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
        ).bind(channelId, category.id, category.catalogKey, now, now));
      }
      await db.batch(statements);
    },
    list,
    find,
    async create(input, actor) {
      await repository.initialize(input.channelId, input.now);
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
    async delete(channelId, name, revision, graphRevision, actor, now) {
      const before = await find(channelId, name);
      if (before === null) return { ok: false, reason: "not_found" };
      if (before.revision !== revision) return { ok: false, reason: "conflict", current: before };
      const authorization = authorizeMutation(channelId, actor, now);
      const advanceGraph = db.prepare(
        `UPDATE text_library_settings SET graph_revision = graph_revision + 1
          WHERE channel_id = ? AND graph_revision = ?
            AND EXISTS (SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ?)
            ${authorization.sql}`,
      ).bind(channelId, graphRevision, channelId, name, revision, ...authorization.values);
      const mutation = db.prepare("DELETE FROM text_blocks WHERE channel_id = ? AND block_name = ? AND revision = ? AND changes() > 0 " + authorization.sql)
        .bind(channelId, name, revision, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.block.removed" satisfies AuditAction, before: { name, categoryId: before.categoryId }, after: null }, now);
      const results = await db.batch([advanceGraph, mutation, ...(audit === undefined ? [] : [audit])]);
      const changes = results[1]?.meta.changes ?? 0;
      if (changes > 0) return { ok: true, block: before };
      const current = await find(channelId, name);
      const settings = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
        .bind(channelId).first<{ graph_revision: number }>();
      return { ok: false, reason: settings?.graph_revision === graphRevision ? "not_authorized" : "conflict", ...(current === null ? {} : { current }) };
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
      await repository.initialize(channelId, now);
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
    async updateTimeZone(channelId, timeZone, revision, actor, now) {
      await repository.initialize(channelId, now);
      const authorization = authorizeMutation(channelId, actor, now);
      const before = await db.prepare("SELECT time_zone, revision FROM text_library_settings WHERE channel_id = ?")
        .bind(channelId).first<{ time_zone: string; revision: number }>();
      if (before === null || before.revision !== revision) return false;
      const mutation = db.prepare(
        `UPDATE text_library_settings SET time_zone = ?, revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND revision = ? ${authorization.sql}`,
      ).bind(timeZone, now, channelId, revision, ...authorization.values);
      const audit = prepareModuleAudit?.({ channelId, moduleId: MODULE_ID, action: "text_library.settings.updated" satisfies AuditAction, before: { timeZone: before.time_zone }, after: { timeZone } }, now);
      const changes = (await db.batch([mutation, ...(audit === undefined ? [] : [audit])]))[0]?.meta.changes ?? 0;
      return changes > 0;
    },
  };
  return repository;
};
