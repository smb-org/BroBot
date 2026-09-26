import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { TextBlock, TwitchGame } from "./contracts";
import { TEXT_BLOCK_MAXIMUMS } from "./contracts";
import { firstMatchingTextBlockVariant, textBlockAppliesToGame, validTextBlock, validTimeZone } from "./domain";
import { createTextBlockRepository } from "./adapters/d1";
import type { TextBlockInput } from "./repository";
import { createTextLibraryService } from "./service";
import type { ModuleRouteEnvironment } from "../contract";

const gameSchema = z.object({ id: z.string().regex(/^[0-9]{1,20}$/u), name: z.string().trim().min(1).max(100) });
const conditionsSchema = z.object({
  stream: z.enum(["online", "offline"]).optional(),
  game: z.object({ mode: z.enum(["is", "is_not"]), game: gameSchema }).optional(),
  minimumTier: z.enum(["everyone", "subscriber", "vip", "moderator", "broadcaster"]).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  timeWindow: z.object({ start: z.string(), end: z.string() }).optional(),
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
const timeZoneSchema = z.object({ timeZone: z.string().min(1).max(80), revision: z.number().int().min(1) });
const previewSchema = z.object({
  streamState: z.enum(["online", "offline", "unknown"]).default("offline"),
  gameId: z.string().nullable().default(null),
  chatStatus: z.array(z.enum(["viewer", "subscriber", "vip", "moderator", "broadcaster"])).nullable().default(null),
  now: z.number().int().optional(),
});

const nowIso = (): string => new Date().toISOString();
const param = (context: { req: { param: (name: string) => string | undefined } }, name: string): string => context.req.param(name) ?? "";
const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const denied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "text_library_management_denied" }, 403);

const parseBlock = (raw: unknown): Omit<TextBlockInput, "channelId" | "now" | "expectedGraphRevision"> | null => {
  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) return null;
  const variants: TextBlock["variants"] = parsed.data.variants.map((variant) => ({
    id: variant.id,
    conditions: variant.conditions as TextBlock["variants"][number]["conditions"],
    texts: variant.texts,
  }));
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

textLibraryRoutes.get("/games", async (context) => {
  const query = (context.req.query("q") ?? "").trim();
  if (query.length < 2 || query.length > 100) return context.json({ games: [] });
  try {
    const now = nowIso();
    const token = await context.get("measureServerTiming")("helix", () => context.get("getAppAccessToken")(context.env, now));
    const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{
      data?: readonly { id?: unknown; name?: unknown }[];
    }>({
      url: "https://api.twitch.tv/helix/search/categories",
      query: { query, first: "20" },
      accessToken: token,
      clientId: context.env.TWITCH_CLIENT_ID,
    }));
    if (!result.ok) return context.json({ error: "text_library_games_unavailable" }, 503);
    const resultRows: unknown = result.data.data;
    if (!Array.isArray(resultRows)) return context.json({ error: "text_library_games_unavailable" }, 503);
    const games: TwitchGame[] = resultRows.flatMap((entry: unknown): TwitchGame[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const id: unknown = Reflect.get(entry, "id");
      const name: unknown = Reflect.get(entry, "name");
      return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
    });
    return context.json({ games });
  } catch {
    return context.json({ error: "text_library_games_unavailable" }, 503);
  }
});

textLibraryRoutes.get("/library", async (context) => {
  const channelId = param(context, "channelId");
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeMutation"), context.get("prepareModuleAudit")));
  return context.json(await service.list(channelId, await context.get("templateUsageSources")(channelId)));
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
  const parsed = parseBlock(await readBody(context.req.raw));
  if (parsed === null || parsed.expectedRevision !== undefined) return context.json({ error: "text_library_block_invalid" }, 400);
  const channelId = param(context, "channelId");
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit")));
  const snapshot = await service.list(channelId);
  const result = await service.create({ channelId, ...parsed, expectedGraphRevision: snapshot.settings.graphRevision, now: nowIso() }, context.get("actor"));
  if (result.ok) return context.json({ block: result.block }, 201);
  if (result.reason === "already_exists") return context.json({ error: "text_library_block_exists" }, 409);
  if (result.reason === "category_not_found") return context.json({ error: "text_library_category_not_found" }, 400);
  if (result.reason === "reference_cycle" || result.reason === "reference_depth_exceeded") {
    return context.json({ error: `text_library_${result.reason}`, ...(result.path === undefined ? {} : { path: result.path }) }, 400);
  }
  return context.json({ error: result.reason === "limit_reached" ? "text_library_block_limit" : `text_library_${result.reason}` }, result.reason === "not_authorized" ? 403 : result.reason === "conflict" ? 409 : 400);
});

textLibraryRoutes.patch("/blocks/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const parsed = parseBlock(await readBody(context.req.raw));
  const channelId = param(context, "channelId");
  const oldName = param(context, "name");
  if (parsed === null || parsed.name !== oldName || parsed.expectedRevision === undefined) {
    return context.json({ error: "text_library_block_invalid" }, 400);
  }
  const service = createTextLibraryService(createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit")));
  const snapshot = await service.list(channelId);
  const result = await service.change({ channelId, ...parsed, expectedGraphRevision: snapshot.settings.graphRevision, now: nowIso() }, context.get("actor"));
  if (result.ok) return context.json({ block: result.block });
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
  if (result.ok) return context.json({ ok: true });
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

textLibraryRoutes.patch("/settings", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const parsed = timeZoneSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success || !validTimeZone(parsed.data.timeZone)) return context.json({ error: "text_library_time_zone_invalid" }, 400);
  const repository = createTextBlockRepository(context.env.DB, context.get("authorizeManagementMutation"), context.get("prepareModuleAudit"));
  const changed = await repository.updateTimeZone(param(context, "channelId"), parsed.data.timeZone, parsed.data.revision, context.get("actor"), nowIso());
  return changed ? context.json({ ok: true }) : context.json({ error: "text_library_settings_conflict" }, 409);
});

textLibraryRoutes.post("/preview/:name", async (context) => {
  const parsed = previewSchema.safeParse(await readBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "text_library_preview_invalid" }, 400);
  const repository = createTextBlockRepository(context.env.DB, context.get("authorizeMutation"), context.get("prepareModuleAudit"));
  const [snapshot, block] = await Promise.all([
    repository.list(param(context, "channelId")),
    repository.find(param(context, "channelId"), param(context, "name")),
  ]);
  if (block === null) return context.json({ error: "text_library_block_not_found" }, 404);
  if (!textBlockAppliesToGame(block, parsed.data.gameId)) {
    return context.json({ variantId: null, text: "", timeZone: snapshot.settings.timeZone });
  }
  const simulatedGame = parsed.data.gameId === null ? null : block.games.find((game) => game.id === parsed.data.gameId)
    ?? block.variants.flatMap((candidate) => candidate.conditions.game === undefined ? [] : [candidate.conditions.game.game])
      .find((game) => game.id === parsed.data.gameId)
    ?? { id: parsed.data.gameId, name: "" };
  const variant = firstMatchingTextBlockVariant(block.variants, {
    streamState: parsed.data.streamState,
    game: simulatedGame,
    chatStatus: parsed.data.chatStatus,
    commandContext: parsed.data.chatStatus !== null,
    timeZone: snapshot.settings.timeZone,
    now: parsed.data.now ?? Date.now(),
  });
  return context.json({ variantId: variant?.id ?? null, text: variant?.texts[0] ?? "", timeZone: snapshot.settings.timeZone });
});
