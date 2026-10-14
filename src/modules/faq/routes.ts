import { Hono, type Context } from "hono";
import { canManage, type AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { validateEventTemplateText } from "../contracts/text-block-validation";
import { templateTextLength } from "../../contracts/template-text-length";
import { readTextBlockGraphRevision, textBlockGraphRevisionChanged, textBlockWriteGuard } from "../contracts/text-block-write-guard";
import { createFaqRepository, mapFaqEntryRow, type FaqEntryRow } from "./adapters/d1";
import { FAQ_ANSWER_MAX_LENGTH, FAQ_COOLDOWN_MAXIMUM_SECONDS, FAQ_COOLDOWN_MINIMUM_SECONDS, FAQ_ENTRY_MAXIMUM_COUNT, FAQ_ENTRY_NAME_MAX_LENGTH, FAQ_GAME_MAXIMUM_COUNT, FAQ_MINIMUM_TIERS, FAQ_PATTERN_MAXIMUM_COUNT, FAQ_PATTERN_MAX_LENGTH, FAQ_USER_COOLDOWN_MAXIMUM_SECONDS, FAQ_MODULE_ID } from "./contracts";
import type { FaqEntry, FaqGame, FaqMinimumTier, FaqMutationInput } from "./contracts";
import { faqMatcherValidationError, validFaqMatcher } from "./domain";

const nowIso = (): string => new Date().toISOString();
const readBody = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type FaqRouteContext = Context<ModuleRouteEnvironment>;

const denied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "faq_management_denied" }, 403);

const parseGames = (value: unknown): FaqGame[] | null => {
  if (!Array.isArray(value) || value.length > FAQ_GAME_MAXIMUM_COUNT) return null;
  const games: FaqGame[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 32 ||
        typeof item.name !== "string" || item.name.trim().length < 1 || item.name.length > 100 ||
        (item.boxArtUrlTemplate !== undefined && typeof item.boxArtUrlTemplate !== "string")) return null;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    games.push({
      id: item.id,
      name: item.name.trim(),
      ...(typeof item.boxArtUrlTemplate === "string" ? { boxArtUrlTemplate: item.boxArtUrlTemplate } : {}),
    });
  }
  return games;
};

const parseMutation = (value: unknown, existing?: FaqEntry): FaqMutationInput | null => {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length < 1 ||
      value.name.trim().length > FAQ_ENTRY_NAME_MAX_LENGTH || !validFaqMatcher(value.matcher) ||
      typeof value.answerText !== "string" || value.answerText.trim().length === 0 || templateTextLength(value.answerText) > FAQ_ANSWER_MAX_LENGTH ||
      (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
      (value.minimumTier !== undefined && !FAQ_MINIMUM_TIERS.includes(value.minimumTier as FaqMinimumTier)) ||
      !Number.isSafeInteger(value.cooldownSeconds) || (value.cooldownSeconds as number) < FAQ_COOLDOWN_MINIMUM_SECONDS ||
      (value.cooldownSeconds as number) > FAQ_COOLDOWN_MAXIMUM_SECONDS ||
      (value.chatTarget !== undefined && value.chatTarget !== null && value.chatTarget !== "all_chats" &&
        value.chatTarget !== "source_only" && value.chatTarget !== "where_asked")) return null;
  const userCooldownSeconds = value.userCooldownSeconds ?? 0;
  if (!Number.isSafeInteger(userCooldownSeconds) || (userCooldownSeconds as number) < 0 ||
      (userCooldownSeconds as number) > FAQ_USER_COOLDOWN_MAXIMUM_SECONDS) return null;
  const games = parseGames(value.games);
  if (games === null) return null;
  const matcher = value.matcher;
  const normalizedMatcher: FaqMutationInput["matcher"] = matcher.type === "keywords"
    ? { type: "keywords", patterns: matcher.patterns.map((pattern) => pattern.trim()) }
    : { type: "regex", pattern: matcher.pattern };
  if (matcher.type === "keywords" && (matcher.patterns.length > FAQ_PATTERN_MAXIMUM_COUNT ||
      matcher.patterns.some((pattern) => pattern.length === 0 || pattern.length > FAQ_PATTERN_MAX_LENGTH))) return null;
  return {
    name: value.name.trim(),
    enabled: value.enabled === undefined ? existing?.enabled ?? true : value.enabled,
    matcher: normalizedMatcher,
    answerText: value.answerText,
    minimumTier: value.minimumTier === undefined ? existing?.minimumTier ?? "everyone" : value.minimumTier as FaqMinimumTier,
    cooldownSeconds: value.cooldownSeconds as number,
    userCooldownSeconds: userCooldownSeconds as number,
    games,
    chatTarget: value.chatTarget === undefined ? null : value.chatTarget,
  };
};

const readEntry = async (context: FaqRouteContext, channelId: string, id: string): Promise<FaqEntry | null> => {
  const row = await context.env.DB.prepare(
    `SELECT faq_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier, cooldown_seconds, user_cooldown_seconds,
            games_json, chat_target, use_channel_default_target, sort_order, revision, last_used_at, created_at, updated_at
       FROM faq_entries WHERE channel_id = ? AND faq_id = ?`,
  ).bind(channelId, id).first<FaqEntryRow>();
  return row === null ? null : mapFaqEntryRow(row);
};

const snapshot = (entry: Pick<FaqEntry, "id" | "name" | "enabled" | "matcher" | "answerText" | "minimumTier" | "cooldownSeconds" | "userCooldownSeconds" | "games" | "chatTarget" | "order">) => ({
  entryId: entry.id,
  name: entry.name,
  enabled: entry.enabled,
  matcherType: entry.matcher.type,
  patterns: entry.matcher.type === "keywords" ? entry.matcher.patterns : [entry.matcher.pattern],
  answerText: entry.answerText,
  minimumTier: entry.minimumTier,
  cooldownSeconds: entry.cooldownSeconds,
  userCooldownSeconds: entry.userCooldownSeconds,
  games: entry.games.map((game) => game.id),
  chatTarget: entry.chatTarget,
  order: entry.order,
});

const textValidationError = (reason: "missing" | "input_dependent"): string =>
  reason === "input_dependent" ? "faq_text_input_dependent" : "faq_text_block_missing";

const validateAnswer = async (
  context: FaqRouteContext,
  channelId: string,
  text: string,
): Promise<string | null> => {
  const variables = await context.get("listRegisteredTemplateVariables")(channelId);
  const validation = await validateEventTemplateText(context.env.DB, channelId, text, variables);
  return validation.ok ? null : textValidationError(validation.reason);
};

const authorizationFor = (context: FaqRouteContext, channelId: string, now: string) =>
  context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);

const cooldownTooShort = (value: unknown): boolean =>
  isRecord(value) && Number.isSafeInteger(value.cooldownSeconds) &&
  (value.cooldownSeconds as number) < FAQ_COOLDOWN_MINIMUM_SECONDS;

export const faqRoutes = new Hono<ModuleRouteEnvironment>();

faqRoutes.get("/entries", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  return context.json({ entries: await createFaqRepository(context.env.DB).list(channelId) });
});

faqRoutes.post("/entries", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = context.req.param("channelId") ?? "";
  const body = await readBody(context.req.raw);
  if (cooldownTooShort(body)) return context.json({ error: "faq_cooldown_too_short" }, 400);
  const matcherError = faqMatcherValidationError(isRecord(body) ? body.matcher : null);
  if (matcherError !== null) return context.json({ error: "faq_matcher_invalid", ...matcherError }, 400);
  const input = parseMutation(body);
  if (input === null) return context.json({ error: "faq_entry_invalid" }, 400);
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const invalidText = await validateAnswer(context, channelId, input.answerText);
  if (invalidText !== null) return context.json({ error: invalidText }, 400);
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, [input.answerText]);
  const count = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM faq_entries WHERE channel_id = ?")
    .bind(channelId).first<{ count: number }>();
  if ((count?.count ?? 0) >= FAQ_ENTRY_MAXIMUM_COUNT) return context.json({ error: "faq_entry_limit_reached" }, 409);

  const entryId = crypto.randomUUID();
  const now = nowIso();
  const orderRow = await context.env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS last_order FROM faq_entries WHERE channel_id = ?")
    .bind(channelId).first<{ last_order: number }>();
  const order = (orderRow?.last_order ?? -1) + 1;
  const authorization = authorizationFor(context, channelId, now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO faq_entries
       (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier, cooldown_seconds, user_cooldown_seconds,
       games_json, chat_target, use_channel_default_target, sort_order, revision, last_used_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?
      WHERE (SELECT COUNT(*) FROM faq_entries WHERE channel_id = ?) < ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(entryId, channelId, input.name, input.enabled ? 1 : 0, input.matcher.type, JSON.stringify(input.matcher), input.answerText,
    input.minimumTier, input.cooldownSeconds, input.userCooldownSeconds, JSON.stringify(input.games), input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0, order,
    now, now, channelId, FAQ_ENTRY_MAXIMUM_COUNT, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: FAQ_MODULE_ID,
    action: "faq.entry.created" satisfies AuditAction,
    before: null,
    after: { ...snapshot({ id: entryId, ...input, order }), revision: 1 },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    if (await textBlockGraphRevisionChanged(context.env.DB, channelId, graphRevision)) {
      return context.json({ error: "faq_entry_conflict" }, 409);
    }
    const currentCount = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM faq_entries WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (currentCount?.count ?? 0) >= FAQ_ENTRY_MAXIMUM_COUNT
      ? context.json({ error: "faq_entry_limit_reached" }, 409)
      : context.json({ error: "faq_management_denied" }, 403);
  }
  createFaqRepository(context.env.DB).invalidate(channelId);
  return context.json({ entry: await readEntry(context, channelId, entryId) }, 201);
});

faqRoutes.patch("/entries/:entryId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = context.req.param("channelId") ?? "";
  const entryId = context.req.param("entryId");
  const existing = await readEntry(context, channelId, entryId);
  if (existing === null) return context.json({ error: "faq_entry_not_found" }, 404);
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
    return context.json({ error: "faq_entry_invalid" }, 400);
  }
  if (cooldownTooShort(body)) return context.json({ error: "faq_cooldown_too_short" }, 400);
  const matcherError = faqMatcherValidationError(body.matcher);
  if (matcherError !== null) return context.json({ error: "faq_matcher_invalid", ...matcherError }, 400);
  const input = parseMutation(body, existing);
  if (input === null) return context.json({ error: "faq_entry_invalid" }, 400);
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const invalidText = await validateAnswer(context, channelId, input.answerText);
  if (invalidText !== null) return context.json({ error: invalidText }, 400);
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, [input.answerText]);
  const now = nowIso();
  const authorization = authorizationFor(context, channelId, now);
  const mutation = context.env.DB.prepare(
    `UPDATE faq_entries
        SET name = ?, enabled = ?, matcher_type = ?, matcher_json = ?, answer_text = ?, minimum_tier = ?, cooldown_seconds = ?, user_cooldown_seconds = ?,
            games_json = ?, chat_target = ?, use_channel_default_target = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND faq_id = ? AND revision = ? ${blockGuard.sql} ${authorization.sql}`,
  ).bind(input.name, input.enabled ? 1 : 0, input.matcher.type, JSON.stringify(input.matcher), input.answerText, input.minimumTier, input.cooldownSeconds,
    input.userCooldownSeconds, JSON.stringify(input.games), input.chatTarget ?? "source_only",
    input.chatTarget === null ? 1 : 0, now, channelId, entryId,
    body.revision, ...blockGuard.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: FAQ_MODULE_ID,
    action: "faq.entry.updated" satisfies AuditAction,
    before: snapshot(existing),
    after: { ...snapshot({ ...existing, ...input }), revision: existing.revision + 1 },
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const current = await readEntry(context, channelId, entryId);
    return context.json({ error: current === null ? "faq_entry_not_found" : "faq_entry_conflict", ...(current === null ? {} : { entry: current }) }, 409);
  }
  createFaqRepository(context.env.DB).invalidate(channelId);
  return context.json({ entry: await readEntry(context, channelId, entryId) });
});

faqRoutes.post("/entries/order", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = context.req.param("channelId") ?? "";
  const body = await readBody(context.req.raw);
  if (!isRecord(body) || !Array.isArray(body.order) || body.order.length > FAQ_ENTRY_MAXIMUM_COUNT) {
    return context.json({ error: "faq_entry_order_invalid" }, 400);
  }
  const requested = body.order.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0 ||
        !Number.isSafeInteger(item.revision) || (item.revision as number) < 1) return [];
    return [{ id: item.id, revision: item.revision as number }];
  });
  if (requested.length !== body.order.length || new Set(requested.map((entry) => entry.id)).size !== requested.length) {
    return context.json({ error: "faq_entry_order_invalid" }, 400);
  }

  const repository = createFaqRepository(context.env.DB);
  const entries = await repository.list(channelId);
  const currentById = new Map(entries.map((entry) => [entry.id, entry]));
  if (requested.length !== entries.length || requested.some((item) => currentById.get(item.id)?.revision !== item.revision)) {
    return context.json({ error: "faq_entry_conflict" }, 409);
  }
  const nextEntries = requested.map(({ id }) => currentById.get(id)).filter((entry): entry is FaqEntry => entry !== undefined);
  const changedCount = nextEntries.reduce((count, entry, index) => count + (entry.order === index ? 0 : 1), 0);
  if (changedCount === 0) return context.json({ entries });

  const now = nowIso();
  const authorization = authorizationFor(context, channelId, now);
  const serializedOrder = JSON.stringify(requested);
  const mutation = context.env.DB.prepare(
    `WITH requested(faq_id, sort_order, revision) AS MATERIALIZED (
       SELECT json_extract(value, '$.id'), CAST(key AS INTEGER), CAST(json_extract(value, '$.revision') AS INTEGER)
         FROM json_each(?)
     ),
     valid AS MATERIALIZED (
       SELECT requested.faq_id, requested.sort_order, requested.revision
         FROM requested
        WHERE (SELECT COUNT(*) FROM faq_entries WHERE channel_id = ?) = (SELECT COUNT(*) FROM requested)
          AND NOT EXISTS (
            SELECT 1
              FROM requested AS expected
              LEFT JOIN faq_entries AS current
                ON current.channel_id = ? AND current.faq_id = expected.faq_id
             WHERE current.faq_id IS NULL OR current.revision != expected.revision
          )
     )
     UPDATE faq_entries
        SET sort_order = (SELECT sort_order FROM valid WHERE valid.faq_id = faq_entries.faq_id),
            revision = revision + 1, updated_at = ?
      WHERE channel_id = ?
        AND EXISTS (SELECT 1 FROM valid WHERE valid.faq_id = faq_entries.faq_id AND valid.revision = faq_entries.revision)
        AND sort_order != (SELECT sort_order FROM valid WHERE valid.faq_id = faq_entries.faq_id)
        ${authorization.sql}`,
  ).bind(serializedOrder, channelId, channelId, now, channelId, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: FAQ_MODULE_ID,
    action: "faq.entry.reordered" satisfies AuditAction,
    before: { priority: entries.map(({ id, order }) => `${id}:${String(order)}`) },
    after: { priority: nextEntries.map(({ id }, order) => `${id}:${String(order)}`) },
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) !== changedCount) return context.json({ error: "faq_entry_conflict" }, 409);
  repository.invalidate(channelId);
  return context.json({ entries: await repository.list(channelId) });
});

faqRoutes.delete("/entries/:entryId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = context.req.param("channelId") ?? "";
  const entryId = context.req.param("entryId");
  const existing = await readEntry(context, channelId, entryId);
  if (existing === null) return context.json({ error: "faq_entry_not_found" }, 404);
  const revision = Number(context.req.query("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) return context.json({ error: "faq_entry_invalid" }, 400);
  const now = nowIso();
  const authorization = authorizationFor(context, channelId, now);
  const mutation = context.env.DB.prepare(
    "DELETE FROM faq_entries WHERE channel_id = ? AND faq_id = ? AND revision = ? " + authorization.sql,
  ).bind(channelId, entryId, revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: FAQ_MODULE_ID,
    action: "faq.entry.removed" satisfies AuditAction,
    before: snapshot(existing),
    after: null,
  }, now);
  const results = await context.env.DB.batch([mutation, audit]);
  if (results[0]?.meta.changes === 0) {
    const current = await readEntry(context, channelId, entryId);
    return context.json({ error: current === null ? "faq_entry_not_found" : "faq_entry_conflict" }, 409);
  }
  createFaqRepository(context.env.DB).invalidate(channelId);
  return context.json({ removed: true });
});
