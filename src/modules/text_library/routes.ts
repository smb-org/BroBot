import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { TextBlock } from "./contracts";
import { TEXT_BLOCK_MAXIMUMS } from "./contracts";
import { blockReferencesInText, validTextBlock } from "./domain";
import { createTextBlockRepository } from "./adapters/d1";
import type { TextBlockInput } from "./repository";
import { createTextLibraryService } from "./service";
import { TEXT_BLOCK_OVERLAY_ELEMENT_KIND } from "./overlay/element";
import { MODULE_TEMPLATE_MINIMUM_TIERS, SYSTEM_TEMPLATE_VARIABLE_LIST, type ModuleRouteEnvironment, type ModuleTextBlockConditionDefinition } from "../contract";

const TEXT_LIBRARY_MODULE_ID = "text_library";

const boxArtUrlTemplateSchema = z.string().max(500).refine((value) => {
  try {
    const url = new URL(value.replaceAll("{width}", "100").replaceAll("{height}", "100"));
    return url.protocol === "https:" && url.hostname === "static-cdn.jtvnw.net";
  } catch {
    return false;
  }
}, "Invalid Twitch box art URL");
const gameSchema = z.object({
  id: z.string().regex(/^[0-9]{1,20}$/u),
  name: z.string().trim().min(1).max(100),
  boxArtUrlTemplate: boxArtUrlTemplateSchema.optional(),
}).transform(({ boxArtUrlTemplate, ...game }) => boxArtUrlTemplate === undefined
  ? game
  : { ...game, boxArtUrlTemplate });
const conditionsSchema = z.object({
  stream: z.enum(["online", "offline"]).optional(),
  game: z.object({ mode: z.enum(["is", "is_not"]), game: gameSchema }).optional(),
  minimumTier: z.enum(MODULE_TEMPLATE_MINIMUM_TIERS).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  timeWindow: z.object({ start: z.string(), end: z.string() }).optional(),
  data: z.record(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u), z.string().min(1).max(32)).optional(),
});
const variantSchema = z.object({
  id: z.string().min(1).max(80),
  conditions: conditionsSchema.default({}),
  texts: z.array(z.string().trim().min(1).max(TEXT_BLOCK_MAXIMUMS.textLength)).min(1).max(TEXT_BLOCK_MAXIMUMS.textsPerVariant),
});
const blockSchema = z.object({
  name: z.string(),
  categoryId: z.string().min(1).max(40),
  games: z.array(gameSchema).max(50).default([]),
  variants: z.array(variantSchema).min(1).max(TEXT_BLOCK_MAXIMUMS.variantsPerBlock),
  revision: z.number().int().min(1).optional(),
});
const categorySchema = z.object({ name: z.string().trim().min(1).max(TEXT_BLOCK_MAXIMUMS.categoryNameLength) });

const nowIso = (): string => new Date().toISOString();
const param = (context: { req: { param: (name: string) => string | undefined } }, name: string): string => context.req.param(name) ?? "";
const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const denied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "text_library_management_denied" }, 403);

const blocksAffectedBy = (blocks: readonly TextBlock[], changedName: string): string[] => {
  const affected = new Set([changedName]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (affected.has(block.name)) continue;
      const references = block.variants.flatMap((variant) => variant.texts.flatMap(blockReferencesInText));
      if (references.some((name) => affected.has(name))) {
        affected.add(block.name);
        changed = true;
      }
    }
  }
  return [...affected];
};

const publishBlockInvalidations = async (
  publish: ModuleRouteEnvironment["Variables"]["publishModuleOverlayMessage"],
  channelId: string,
  blocks: readonly TextBlock[],
  changedName: string,
): Promise<void> => {
  await Promise.all(blocksAffectedBy(blocks, changedName).map((blockName) => publish(
    channelId,
    TEXT_LIBRARY_MODULE_ID,
    "blocks_updated",
    TEXT_BLOCK_OVERLAY_ELEMENT_KIND,
    { blockName },
    { field: "blockName", value: blockName },
  )));
};

const parseBlock = (
  raw: unknown,
  dataConditions: readonly ModuleTextBlockConditionDefinition[],
): Omit<TextBlockInput, "channelId" | "now" | "expectedGraphRevision"> | null => {
  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) return null;
  const variants: TextBlock["variants"] = parsed.data.variants.map((variant) => ({
    id: variant.id,
    conditions: variant.conditions as TextBlock["variants"][number]["conditions"],
    texts: variant.texts,
  }));
  const allowedDataConditions = new Map(dataConditions.map((condition) => [condition.id, new Set(Object.keys(condition.values))]));
  if (variants.some((variant) => Object.entries(variant.conditions.data ?? {}).some(([id, value]) =>
    !allowedDataConditions.get(id)?.has(value),
  ))) return null;
  const block = {
    name: parsed.data.name,
    categoryId: parsed.data.categoryId,
    games: parsed.data.games,
    variants,
  } satisfies Pick<TextBlock, "name" | "categoryId" | "games" | "variants">;
  if (!validTextBlock(block)) return null;
  return {
    ...block,
    ...(parsed.data.revision === undefined ? {} : { expectedRevision: parsed.data.revision }),
  };
};

export const textLibraryRoutes = new Hono<ModuleRouteEnvironment>();

textLibraryRoutes.get("/library", async (context) => {
  const channelId = param(context, "channelId");
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeMutation"), context.get("prepareModuleAudit")));
  const [data, registeredVariables] = await Promise.all([
    service.list(channelId, await context.get("templateUsageSources")(channelId)),
    context.get("listRegisteredTemplateVariables")(channelId),
  ]);
  const conditionIds = [...new Set(data.blocks.flatMap((block) => block.variants.flatMap((variant) => Object.keys(variant.conditions.data ?? {}))))];
  const dataConditionValues = await context.get("resolveTextBlockConditions")(channelId, conditionIds, Date.now());
  const reservedNames = [...new Set([
    ...SYSTEM_TEMPLATE_VARIABLE_LIST.map((variable) => variable.name),
    ...registeredVariables.filter(({ moduleId }) => moduleId !== TEXT_LIBRARY_MODULE_ID).map(({ name }) => name),
  ])];
  return context.json({ ...data, reservedNames, dataConditionValues });
});

textLibraryRoutes.get("/blocks", async (context) => {
  const result = await context.env.DB.prepare(
    "SELECT block_name AS name FROM text_blocks WHERE channel_id = ? ORDER BY block_name",
  ).bind(param(context, "channelId")).all<{ name: string }>();
  return context.json({ blocks: result.results });
});

textLibraryRoutes.get("/blocks/:name", async (context) => {
  const channelId = param(context, "channelId");
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeMutation"), context.get("prepareModuleAudit")));
  const block = await service.find(channelId, param(context, "name"));
  return block === null ? context.json({ error: "text_library_block_not_found" }, 404) : context.json({ block });
});

textLibraryRoutes.post("/blocks", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const [raw, dataConditions] = await Promise.all([
    readBody(context.req.raw),
    context.get("listTextBlockConditions")(),
  ]);
  const parsed = parseBlock(raw, dataConditions);
  if (parsed === null || parsed.expectedRevision !== undefined) return context.json({ error: "text_library_block_invalid" }, 400);
  const channelId = param(context, "channelId");
  const reservedNames = new Set([
    ...SYSTEM_TEMPLATE_VARIABLE_LIST.map((variable) => variable.name),
    ...(await context.get("listRegisteredTemplateVariables")(channelId))
      .filter(({ moduleId }) => moduleId !== TEXT_LIBRARY_MODULE_ID)
      .map(({ name }) => name),
  ]);
  if (reservedNames.has(parsed.name)) return context.json({ error: "text_library_block_reserved_name" }, 400);
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit")));
  const snapshot = await service.list(channelId);
  const result = await service.create({ channelId, ...parsed, expectedGraphRevision: snapshot.settings.graphRevision, now: nowIso() }, context.get("actor"), snapshot);
  if (result.ok) {
    await publishBlockInvalidations(context.get("publishModuleOverlayMessage"), channelId, [...snapshot.blocks, result.block], result.block.name);
    return context.json({ block: result.block }, 201);
  }
  if (result.reason === "already_exists") return context.json({ error: "text_library_block_exists" }, 409);
  if (result.reason === "category_not_found") return context.json({ error: "text_library_category_not_found" }, 400);
  if (result.reason === "reference_cycle" || result.reason === "reference_depth_exceeded") {
    return context.json({ error: `text_library_${result.reason}`, ...(result.path === undefined ? {} : { path: result.path }) }, 400);
  }
  return context.json({ error: result.reason === "limit_reached" ? "text_library_block_limit" : `text_library_${result.reason}` }, result.reason === "not_authorized" ? 403 : result.reason === "conflict" ? 409 : 400);
});

textLibraryRoutes.patch("/blocks/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const [raw, dataConditions] = await Promise.all([
    readBody(context.req.raw),
    context.get("listTextBlockConditions")(),
  ]);
  const parsed = parseBlock(raw, dataConditions);
  const channelId = param(context, "channelId");
  const oldName = param(context, "name");
  if (parsed === null || parsed.name !== oldName || parsed.expectedRevision === undefined) {
    return context.json({ error: "text_library_block_invalid" }, 400);
  }
  const reservedNames = new Set([
    ...SYSTEM_TEMPLATE_VARIABLE_LIST.map((variable) => variable.name),
    ...(await context.get("listRegisteredTemplateVariables")(channelId))
      .filter(({ moduleId }) => moduleId !== TEXT_LIBRARY_MODULE_ID)
      .map(({ name }) => name),
  ]);
  if (reservedNames.has(parsed.name)) return context.json({ error: "text_library_block_reserved_name" }, 400);
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit")));
  const snapshot = await service.list(channelId);
  const result = await service.change({ channelId, ...parsed, expectedGraphRevision: snapshot.settings.graphRevision, now: nowIso() }, context.get("actor"), snapshot);
  if (result.ok) {
    await publishBlockInvalidations(context.get("publishModuleOverlayMessage"), channelId,
      snapshot.blocks.map((block) => block.name === result.block.name ? result.block : block), result.block.name);
    return context.json({ block: result.block });
  }
  return context.json({ error: `text_library_${result.reason}`, ...(result.current === undefined ? {} : { current: result.current }), ...(result.path === undefined ? {} : { path: result.path }) }, result.reason === "conflict" ? 409 : result.reason === "not_authorized" ? 403 : 400);
});

textLibraryRoutes.delete("/blocks/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const revision = Number(context.req.query("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) return context.json({ error: "text_library_block_invalid" }, 400);
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit")));
  const channelId = param(context, "channelId");
  const snapshot = await service.list(channelId);
  const result = await service.delete(channelId, param(context, "name"), revision, snapshot.settings.graphRevision, context.get("actor"), nowIso());
  if (result.ok) {
    await publishBlockInvalidations(context.get("publishModuleOverlayMessage"), channelId, snapshot.blocks, param(context, "name"));
    return context.json({ ok: true });
  }
  return context.json({ error: `text_library_${result.reason}`, ...(result.current === undefined ? {} : { current: result.current }) }, result.reason === "conflict" ? 409 : result.reason === "not_authorized" ? 403 : 404);
});

textLibraryRoutes.post("/categories", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const parsed = categorySchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "text_library_category_invalid" }, 400);
  const repository = createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit"));
  const category = await repository.createCategory(param(context, "channelId"), parsed.data.name, context.get("actor"), nowIso());
  return category === null ? context.json({ error: "text_library_category_limit" }, 409) : context.json({ category }, 201);
});

textLibraryRoutes.patch("/categories/:id", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const parsed = categorySchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "text_library_category_invalid" }, 400);
  const repository = createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit"));
  const changed = await repository.renameCategory(param(context, "channelId"), param(context, "id"), parsed.data.name, context.get("actor"), nowIso());
  return changed.ok ? context.json({ ok: true }) : context.json({ error: "text_library_category_not_found" }, 404);
});

textLibraryRoutes.delete("/categories/:id", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const repository = createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit"));
  const result = await repository.deleteCategory(param(context, "channelId"), param(context, "id"), context.get("actor"), nowIso());
  if (result === "ok") return context.json({ ok: true });
  return context.json({ error: result === "not_empty" ? "text_library_category_not_empty" : "text_library_category_not_found" }, result === "not_empty" ? 409 : 404);
});
