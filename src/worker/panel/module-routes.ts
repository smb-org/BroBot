import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  createChannelModuleWithAudit,
  getChannelModuleForChannel,
  updateChannelModuleEnabledStateWithAudit,
  updateChannelModuleSettingsWithAudit,
} from "../db/channel-modules";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import { canManage, type AuditAction } from "../../contracts/values";
import type { ModuleChannelVariable, ModuleEvent, ModuleExternalFetchBudget, ModuleLanguage, ModuleOverlayHostEvent, ModuleRouteVariables, ModuleStreamState, ModuleTemplateConditionContext } from "../../modules/contract";
import { MODULES } from "../../modules/registry";
import { BELABOX_MODULE_ID, BELABOX_STATS_URL_SECRET } from "../../modules/belabox/contracts";
import { validateBelaboxStatsUrl } from "../../modules/belabox/domain/stats-url";
import { resetSampleAfterStatsUrlChangeBestEffort } from "../../modules/belabox/routes";
import type { PanelModuleState } from "../../panel-contract";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { moduleBroadcasterScopeState } from "../module-scopes";
import { getPanelModuleStates } from "./module-repository";
import { actorOf, readJsonBody } from "./member-routes";
import { broadcasterHasScope, broadcasterScopesForChannel } from "../broadcaster-scope";
import { getAppAccessToken } from "../app-token";
import { getLoginIdentity, type LoginIdentityRecord } from "../db/login-identity";
import { getBotIdentity } from "../db/bot-identity";
import { decryptStoredToken } from "../bot-maintenance";
import { getTokenEncryptionKeys } from "../auth/crypto";
import { decryptLoginIdentityAccessToken, refreshLoginIdentityTokens } from "../auth/login-token-refresh";
import { recordAudit } from "../db/audit";
import { writeModuleDiagnostics } from "../event-log";
import { getGlobalEmotes, getUserEmotes, helixRequest } from "../twitch/helix";
import { readChannelBlockedTerms } from "../twitch/blocked-terms";
import { effectiveTemplateVariables, templateTextLength, templateWarnings, type TemplateVariable } from "../../template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../template-variables";
import { listChannelVariables } from "../db/channel-variables";
import { findChannelVariable } from "../db/channel-variables";
import { measureServerTiming, recordServerTiming, scheduleBackgroundWork } from "../server-timing";
import { publishOverlayChanged, publishOverlayHostEvent as publishOverlayHostEventHint, publishRealtimeMessages } from "../realtime";
import { prepareModuleOverlayRealtimeMessage } from "../module-overlay-realtime";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../../modules/contract";
import { readChannelLocation } from "../db/channel-settings";
import { readCachedGameList, readRecentChannelGames, writeCachedGameList, type TwitchGameCategory } from "../db/game-search-cache";
import { createSimulatedTemplateRenderer, registeredTemplateVariablesForChannel } from "../simulated-template-renderer";
export { registeredTemplateVariablesForChannel } from "../simulated-template-renderer";
import { moduleEventTimeOptions, resolveModuleEventTimes } from "../module-event-times";
import { notifyModuleScheduleInputsChanged, reconcileChannelTimerSchedules } from "../module-schedules";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
import { moduleBallots } from "../module-ballots";
import { modulePoints } from "../module-points";
import { createModuleSecretAccess } from "../module-secrets";
import { liftModerationBan } from "../moderation";
import { readTextBlockGraphRevision, textBlockWriteGuard } from "../../modules/contracts/text-block-write-guard";
import { effectiveEventTemplateDeclarations } from "../../modules/contracts/text-block-validation";

interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables & Pick<
    ModuleRouteVariables,
    "writeModuleDiagnostics" | "broadcasterHasScope" | "broadcasterScopesForChannel"
    | "measureServerTiming" | "recordServerTiming" | "scheduleBackgroundWork" | "getAppAccessToken" | "helixRequest"
    | "listChannelVariables" | "findChannelVariable" | "secrets"
    | "externalFetchBudget"
    | "ballots"
    | "points"
    | "botCredentials" | "getUserEmotes" | "getGlobalEmotes"
    | "readChannelBlockedTerms"
    | "runModuleAlarm"
    | "listTextBlockConditions"
    | "listEventTimeSources" | "resolveEventTimes"
    | "notifyScheduleInputsChanged" | "reconcileTimerSchedules" | "validateTemplateContentMutation"
    | "afterTextBlockRename"
    | "resolveTextBlockConditions"
    | "publishModuleOverlayMessage"
    | "publishOverlayHostEvent"
    | "templateUsageSources" | "listRegisteredTemplateVariables"
    | "liftModerationBan"
  >;
}

const nowIso = (): string => new Date().toISOString();
const normalizedGameSearchQuery = (query: string): string => query.trim().replace(/\s+/gu, " ").toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validBoxArtTemplate = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value.replaceAll("{width}", "100").replaceAll("{height}", "100"));
    return url.protocol === "https:" && url.hostname === "static-cdn.jtvnw.net";
  } catch {
    return false;
  }
};

const parseTwitchGame = (value: unknown): TwitchGameCategory | null => {
  if (!isRecord(value) || typeof value.id !== "string" || !/^\d{1,20}$/u.test(value.id) ||
      typeof value.name !== "string" || value.name.trim().length === 0) return null;
  return {
    id: value.id,
    name: value.name.trim().slice(0, 100),
    ...(validBoxArtTemplate(value.box_art_url) ? { boxArtUrlTemplate: value.box_art_url } : {}),
  };
};

const parseTwitchGames = (value: unknown): TwitchGameCategory[] =>
  Array.isArray(value) ? value.flatMap((entry) => {
    const game = parseTwitchGame(entry);
    return game === null ? [] : [game];
  }) : [];

const fetchGamesById = async (
  context: Context<ModuleRouteEnvironment>,
  ids: readonly string[],
  now: number,
): Promise<TwitchGameCategory[]> => {
  const uniqueIds = [...new Set(ids)];
  const cachedGames = await Promise.all(uniqueIds.map((id) =>
    context.get("measureServerTiming")("d1", () => readCachedGameList(context.env.DB, `id:${id}`, now)),
  ));
  const cachedById = new Map<string, TwitchGameCategory>();
  uniqueIds.forEach((id, index) => {
    const cached = cachedGames[index]?.find((game) => game.id === id);
    if (cached !== undefined) cachedById.set(id, cached);
  });
  const missingIds = uniqueIds.filter((id) => !cachedById.has(id));
  if (missingIds.length > 0) {
    const token = await context.get("measureServerTiming")("helix", () =>
      context.get("getAppAccessToken")(context.env, new Date(now).toISOString()),
    );
    const responses = await Promise.all(missingIds.map(async (id) => {
      const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{ data?: unknown }>({
        url: "https://api.twitch.tv/helix/games",
        query: { id },
        accessToken: token,
        clientId: context.env.TWITCH_CLIENT_ID,
      }));
      if (!result.ok || !Array.isArray(result.data.data)) throw new Error("Twitch game ID lookup failed.");
      const game = parseTwitchGames(result.data.data).find((entry) => entry.id === id) ?? null;
      if (game !== null) {
        await context.get("measureServerTiming")("d1", () =>
          writeCachedGameList(context.env.DB, `id:${id}`, [game], now),
        );
      }
      return game;
    }));
    missingIds.forEach((id, index) => {
      const game = responses[index];
      if (game !== null && game !== undefined) cachedById.set(id, game);
    });
  }
  return uniqueIds.flatMap((id) => {
    const game = cachedById.get(id);
    return game === undefined ? [] : [game];
  });
};

const runModuleAlarmAfterMutation = async (
  context: {
    get: (key: "runModuleAlarm") => ModuleRouteVariables["runModuleAlarm"];
    env: Env;
  },
  channelId: string,
  moduleId: string,
  handlerKey: string,
  alarmKey: string,
): Promise<void> => {
  try {
    await context.get("runModuleAlarm")(channelId, moduleId, handlerKey, alarmKey);
  } catch {
    if (moduleId !== "belabox") return;
    try {
      await writeModuleDiagnostics(
        context.env.DB,
        channelId,
        moduleId,
        "belabox:polling_ensure",
        null,
        [{ code: "belabox.polling_ensure_failed" }],
        nowIso(),
      );
    } catch {
      // A committed module mutation remains successful if its diagnostic cannot be stored.
    }
  }
};

const previewSchema = z.object({
  text: z.string().refine((value) => templateTextLength(value) <= 500),
  templateContext: z.enum(["event", "chat_command"]),
  streamState: z.enum(["online", "offline", "unknown"]),
  game: z.object({ id: z.string().regex(/^[0-9]{1,20}$/u), name: z.string().trim().max(100) }).nullable(),
  chatStatus: z.array(z.enum(["viewer", "subscriber", "vip", "moderator", "broadcaster"])).nullable(),
});

const broadcastUpdateSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  gameId: z.string().regex(/^[0-9]{1,20}$/u).or(z.literal("")).optional(),
}).strict().refine((update) => update.title !== undefined || update.gameId !== undefined);

const BROADCAST_MANAGE_SCOPE = "channel:manage:broadcast";

const loginIdentityHasBroadcastScope = (identity: LoginIdentityRecord | null): boolean => {
  if (identity === null || identity.status !== "connected") return false;
  try {
    const scopes: unknown = JSON.parse(identity.tokenScopesJson);
    return Array.isArray(scopes) && scopes.includes(BROADCAST_MANAGE_SCOPE);
  } catch {
    return false;
  }
};

const canManageModules = canManage;

const manageDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "module_management_denied" }, 403);

const moduleState = (
  id: string,
  enabled: boolean,
  settings: string,
  mandatory: boolean,
  requiredBroadcasterScopes: readonly string[] = [],
  missingBroadcasterScopes: readonly string[] = [],
): PanelModuleState => ({
  id,
  enabled: mandatory || enabled,
  settings,
  mandatory,
  ...(requiredBroadcasterScopes.length === 0 ? {} : {
    requiredBroadcasterScopes: [...requiredBroadcasterScopes],
    missingBroadcasterScopes: [...missingBroadcasterScopes],
  }),
});

const moduleStateFor = async (
  db: D1Database,
  channelId: string,
  module: (typeof MODULES)[number],
  enabled: boolean,
  settings: string,
): Promise<PanelModuleState> => {
  const scopes = await moduleBroadcasterScopeState(db, channelId, module);
  return moduleState(module.id, enabled, settings, module.mandatory === true, scopes.required, scopes.missing);
};

export const moduleRouter = new Hono<ModuleRouteEnvironment>();

moduleRouter.use("/api/channels/:channelId/modules", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/modules/*", requireChannelAuthorization());

moduleRouter.use("/api/channels/:channelId/*", (context, next) => {
  const externalFetchBudget: ModuleExternalFetchBudget = createModuleExternalFetchBudget();
  context.set("externalFetchBudget", externalFetchBudget);
  context.set("ballots", (channelId) => {
    if (channelId !== context.req.param("channelId")) throw new Error("Ballot access must use the authorized route channel.");
    const marker = "/modules/";
    const suffix = new URL(context.req.url).pathname.split(marker, 2)[1];
    const moduleId = suffix === undefined ? "" : decodeURIComponent(suffix.split("/", 1)[0] ?? "");
    if (!MODULES.some((module) => module.id === moduleId)) throw new Error("Ballot access requires a registered module route.");
    return moduleBallots(context.env.CHANNEL, channelId, moduleId);
  });
  context.set("points", (channelId) => {
    if (channelId !== context.req.param("channelId")) throw new Error("Point access must use the authorized route channel.");
    const marker = "/modules/";
    const suffix = new URL(context.req.url).pathname.split(marker, 2)[1];
    const moduleId = suffix === undefined ? "" : decodeURIComponent(suffix.split("/", 1)[0] ?? "");
    if (!MODULES.some((module) => module.id === moduleId)) throw new Error("Point access requires a registered module route.");
    return modulePoints(context.env.CHANNEL, channelId, moduleId);
  });
  context.set("botCredentials", async (channelId) => {
    if (channelId !== context.req.param("channelId")) throw new Error("Bot credentials must use the authorized route channel.");
    const identity = await getBotIdentity(context.env.DB);
    if (identity === null) return null;
    const accessToken = await decryptStoredToken(identity.accessTokenCiphertext, getTokenEncryptionKeys(context.env));
    if (accessToken === null) return null;
    let scopes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(identity.scopesJson);
      if (Array.isArray(parsed)) scopes = parsed.filter((scope): scope is string => typeof scope === "string");
    } catch { scopes = []; }
    return { userId: identity.userId, accessToken, scopes };
  });
  context.set("getUserEmotes", (options) => getUserEmotes(options));
  context.set("getGlobalEmotes", (options) => getGlobalEmotes(options));
  context.set("secrets", (channelId) => {
    if (channelId !== context.req.param("channelId")) throw new Error("Module secret access must use the authorized route channel.");
    const marker = "/modules/";
    const suffix = new URL(context.req.url).pathname.split(marker, 2)[1];
    const moduleId = suffix === undefined ? "" : decodeURIComponent(suffix.split("/", 1)[0] ?? "");
    if (!MODULES.some((module) => module.id === moduleId && module.routes !== undefined)) {
      throw new Error("Module secret access requires a registered module route.");
    }
    return createModuleSecretAccess(context.env, channelId, moduleId);
  });
  context.set("runModuleAlarm", (channelId, moduleId, handlerKey, alarmKey, invocation) => {
    if (channelId !== context.req.param("channelId")) throw new Error("Module alarm access must use the authorized route channel.");
    const marker = "/modules/";
    const suffix = new URL(context.req.url).pathname.split(marker, 2)[1];
    const routedModuleId = suffix === undefined ? "" : decodeURIComponent(suffix.split("/", 1)[0] ?? "");
    if (routedModuleId !== moduleId) throw new Error("Module alarm access must use the mounted module route.");
    const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
    return invocation === undefined
      ? object.runModuleAlarm(moduleId, handlerKey, alarmKey)
      : object.runModuleAlarm(moduleId, handlerKey, alarmKey, invocation);
  });
  context.set("writeModuleDiagnostics", writeModuleDiagnostics);
  context.set("broadcasterHasScope", broadcasterHasScope);
  context.set("broadcasterScopesForChannel", broadcasterScopesForChannel);
  context.set("measureServerTiming", (phase, run) => measureServerTiming(context, phase, run));
  context.set("recordServerTiming", (phase, durationMs) => { recordServerTiming(context, phase, durationMs); });
  context.set("scheduleBackgroundWork", (work) => { scheduleBackgroundWork(context, work); });
  context.set("getAppAccessToken", getAppAccessToken);
  context.set("helixRequest", helixRequest);
  context.set("readChannelBlockedTerms", async (channelId) => {
    if (channelId !== context.req.param("channelId")) {
      throw new Error("Blocked-term access must use the authorized route channel.");
    }
    return await readChannelBlockedTerms(context.env, channelId);
  });
  context.set("liftModerationBan", async (channelId, userId, expected) => {
    if (channelId !== context.req.param("channelId")) {
      return { outcome: "rejected", reason: "invalid_request", detail: { target: userId } };
    }
    return liftModerationBan(context.env, channelId, userId, expected);
  });
  context.set("listChannelVariables", async (channelId): Promise<readonly ModuleChannelVariable[]> =>
    (await listChannelVariables(context.env.DB, channelId)).map(({ name, value, description }) => ({ name, value, description })),
  );
  context.set("findChannelVariable", async (channelId, name): Promise<ModuleChannelVariable | null> => {
    const variable = await findChannelVariable(context.env.DB, channelId, name);
    return variable === null ? null : { name: variable.name, value: variable.value, description: variable.description };
  });
  context.set("listRegisteredTemplateVariables", async (channelId) => {
    return registeredTemplateVariablesForChannel(context.env.DB, channelId);
  });
  context.set("listTextBlockConditions", async (channelId) => {
    const conditions = await Promise.all(MODULES.map(async (module) => [
      ...(module.textBlockConditions ?? []),
      ...(await module.textBlockConditionsForChannel?.(context.env.DB, channelId) ?? []),
    ]));
    return conditions.flat();
  });
  context.set("listEventTimeSources", moduleEventTimeOptions);
  context.set("resolveEventTimes", (channelId, now) => resolveModuleEventTimes(context.env.DB, channelId, now));
  context.set("notifyScheduleInputsChanged", (channelId, reason) =>
    notifyModuleScheduleInputsChanged(context.env.CHANNEL, channelId, reason));
  context.set("reconcileTimerSchedules", (channelId) =>
    reconcileChannelTimerSchedules(context.env.CHANNEL, channelId));
  context.set("validateTemplateContentMutation", async (channelId, candidate) => {
    const registeredVariables = await registeredTemplateVariablesForChannel(context.env.DB, channelId);
    const validationContext = { DB: context.env.DB, channelId, candidate, registeredVariables };
    const issues = await Promise.all(MODULES.map((module) =>
      module.validateTemplateContent?.(validationContext) ?? Promise.resolve([]),
    ));
    return issues.flat();
  });
  context.set("afterTextBlockRename", (channelId) => {
    for (const module of MODULES) module.afterTextBlockRename?.(context.env.DB, channelId);
  });
  context.set("resolveTextBlockConditions", async (channelId, ids, now, options) => {
    const requested = new Set(ids);
    const channel = await context.env.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ time_zone: string }>();
    if (channel === null) return {};
    const resolveContext: ModuleTemplateConditionContext = {
      DB: context.env.DB,
      channelId,
      channelTimeZone: () => Promise.resolve(channel.time_zone),
      channelLocation: () => readChannelLocation(context.env.DB, channelId),
      publicOrigin: context.env.PUBLIC_ORIGIN,
      externalFetchBudget: context.get("externalFetchBudget"),
      readOnly: options?.readOnly ?? false,
      now,
    };
    const resolved: Record<string, string> = {};
    for (const module of MODULES) {
      if (module.resolveTemplateConditions === undefined) continue;
      const conditions = [
        ...(module.textBlockConditions ?? []),
        ...(await module.textBlockConditionsForChannel?.(context.env.DB, channelId) ?? []),
      ];
      const declared = new Set(conditions.map(({ id }) => id));
      const moduleIds = ids.filter((id) => requested.has(id) && declared.has(id));
      if (moduleIds.length === 0) continue;
      try {
        Object.assign(resolved, await module.resolveTemplateConditions(moduleIds, resolveContext));
      } catch {
        // A failed data source leaves its conditions unmatched in the editor preview.
      }
    }
    return resolved;
  });
  context.set("publishModuleOverlayMessage", async (channelId, moduleId, type, elementKind, payload, recipientConfig) => {
    try {
      const module = MODULES.find((candidate) => candidate.id === moduleId);
      if (module === undefined) return;
      const prepared = await prepareModuleOverlayRealtimeMessage(
        context.env.DB,
        channelId,
        moduleId,
        {
          kind: "overlay",
          type,
          elementKind,
          payload,
          ...(recipientConfig === undefined ? {} : { recipientConfig }),
        },
        module.mandatory === true,
      );
      if (prepared.outcome === "ready") await publishRealtimeMessages(context.env.CHANNEL, [prepared.message]);
    } catch (error: unknown) {
      console.warn("Module overlay update could not be sent.", error);
    }
  });
  context.set("publishOverlayHostEvent", async (channelId: string, event: ModuleOverlayHostEvent) => {
    await publishOverlayHostEventHint(context.env.CHANNEL, context.env.DB, channelId, event);
  });
  context.set("templateUsageSources", async (channelId) => {
    const moduleSources = await Promise.all(MODULES.map((module) =>
      module.templateUsageSources?.(context.env.DB, channelId) ?? Promise.resolve([]),
    ));
    const overlayRows = await context.env.DB.prepare(
      `SELECT overlay.name AS overlay_name, element.label, element.text, element.config_json,
              CASE WHEN element.kind = 'text_library.block'
                   THEN COALESCE('{text.' || json_extract(element.config_json, '$.blockName') || '}', '')
                   ELSE '' END AS referenced_text_block
         FROM overlay_elements AS element JOIN overlays AS overlay
           ON overlay.channel_id = element.channel_id AND overlay.overlay_id = element.overlay_id
        WHERE element.channel_id = ? ORDER BY overlay.name, element.label`,
    ).bind(channelId).all<{ overlay_name: string; label: string; text: string; config_json: string; referenced_text_block: string }>();
    return [
      ...moduleSources.flat(),
      ...overlayRows.results.map((row) => ({
        text: `${row.text} ${row.config_json} ${row.referenced_text_block}`,
        kind: "overlay" as const,
        label: row.label || row.overlay_name,
      })),
    ];
  });
  return next();
});

moduleRouter.use("/api/channels/:channelId/games", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/broadcast", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/template-variables", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/template-preview", requireChannelAuthorization());

moduleRouter.get("/api/channels/:channelId/games", async (context) => {
  const now = Date.now();
  const rawIds = context.req.query("ids");
  if (rawIds !== undefined) {
    const ids = [...new Set(rawIds.split(","))];
    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !/^\d{1,20}$/u.test(id))) return context.json({ games: [] });
    try {
      const games = await fetchGamesById(context, ids, now);
      return context.json({ games });
    } catch {
      return context.json({ error: "games_unavailable" }, 503);
    }
  }

  const query = normalizedGameSearchQuery(context.req.query("q") ?? "");
  if (query.length === 0) {
    const channelId = context.req.param("channelId");
    const recentGamesPromise = context.get("measureServerTiming")("d1", () => readRecentChannelGames(context.env.DB, channelId));
    let currentGame: TwitchGameCategory | null = null;
    let helixUnavailable = false;
    try {
      const token = await context.get("measureServerTiming")("helix", () =>
        context.get("getAppAccessToken")(context.env, nowIso()),
      );
      const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{ data?: unknown }>({
        url: "https://api.twitch.tv/helix/channels",
        query: { broadcaster_id: channelId },
        accessToken: token,
        clientId: context.env.TWITCH_CLIENT_ID,
      }));
      if (!result.ok || !Array.isArray(result.data.data)) {
        helixUnavailable = true;
      } else {
        const channel = result.data.data.find(isRecord);
        currentGame = channel === undefined ? null : parseTwitchGame({ id: channel.game_id, name: channel.game_name });
      }
    } catch {
      helixUnavailable = true;
    }
    try {
      const recentGames = await recentGamesPromise;
      if (currentGame === null && recentGames.length === 0 && helixUnavailable) {
        return context.json({ error: "games_unavailable" }, 503);
      }
      const suggestions = [
        ...(currentGame === null ? [] : [currentGame]),
        ...recentGames.filter((game) => game.id !== currentGame?.id),
      ];
      let gamesById = new Map<string, TwitchGameCategory>();
      try {
        gamesById = new Map((await fetchGamesById(context, suggestions.map(({ id }) => id), now))
          .map((game) => [game.id, game]));
      } catch {
        // Keep the channel and history names available while artwork is unavailable.
      }
      return context.json({ games: suggestions.map((game) => ({ ...game, ...gamesById.get(game.id) })) });
    } catch {
      return context.json({ error: "games_unavailable" }, 503);
    }
  }
  if (query.length < 2 || query.length > 100) return context.json({ games: [] });
  try {
    const cacheKey = `search:${query}`;
    const cached = await context.get("measureServerTiming")("d1", () =>
      readCachedGameList(context.env.DB, cacheKey, now),
    );
    if (cached !== null) return context.json({ games: cached });
    const token = await context.get("measureServerTiming")("helix", () =>
      context.get("getAppAccessToken")(context.env, new Date(now).toISOString()),
    );
    const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{
      data?: unknown;
    }>({
      url: "https://api.twitch.tv/helix/search/categories",
      query: { query, first: "20" },
      accessToken: token,
      clientId: context.env.TWITCH_CLIENT_ID,
    }));
    if (!result.ok || !Array.isArray(result.data.data)) return context.json({ error: "games_unavailable" }, 503);
    const games = parseTwitchGames(result.data.data);
    await context.get("measureServerTiming")("d1", () => writeCachedGameList(context.env.DB, cacheKey, games, now));
    return context.json({ games });
  } catch {
    return context.json({ error: "games_unavailable" }, 503);
  }
});

moduleRouter.get("/api/channels/:channelId/broadcast", async (context) => {
  const channelId = context.req.param("channelId");
  const now = Date.now();
  try {
    const token = await context.get("measureServerTiming")("helix", () =>
      context.get("getAppAccessToken")(context.env, new Date(now).toISOString()),
    );
    const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/channels",
      query: { broadcaster_id: channelId },
      accessToken: token,
      clientId: context.env.TWITCH_CLIENT_ID,
    }));
    if (!result.ok || !Array.isArray(result.data.data)) return context.json({ error: "broadcast_unavailable" }, 503);
    const row = result.data.data.find(isRecord);
    if (row === undefined || typeof row.title !== "string") return context.json({ error: "broadcast_unavailable" }, 503);
    return context.json({
      title: row.title,
      game: parseTwitchGame({ id: row.game_id, name: row.game_name }),
      manageScopeAvailable: loginIdentityHasBroadcastScope(await getLoginIdentity(context.env.DB, channelId)),
    });
  } catch {
    return context.json({ error: "broadcast_unavailable" }, 503);
  }
});

moduleRouter.patch("/api/channels/:channelId/broadcast", async (context) => {
  const channelId = context.req.param("channelId");
  const parsed = broadcastUpdateSchema.safeParse(await readJsonBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "broadcast_invalid" }, 400);

  const managementStillAuthorized = async (): Promise<boolean> => {
    const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), nowIso());
    const authorized = await context.env.DB.prepare(
      `SELECT channel_id FROM channels WHERE channel_id = ? ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ channel_id: string }>();
    return authorized !== null;
  };
  if (!await managementStillAuthorized()) return context.json({ error: "broadcast_manage_denied" }, 403);

  let identity = await getLoginIdentity(context.env.DB, channelId);
  if (identity === null || identity.status !== "connected") return context.json({ error: "broadcast_identity_missing" }, 409);
  if (!loginIdentityHasBroadcastScope(identity)) return context.json({ error: "broadcast_scope_missing" }, 403);
  let accessToken: string | null;
  try {
    accessToken = await decryptLoginIdentityAccessToken(identity, context.env);
  } catch {
    return context.json({ error: "broadcast_identity_missing" }, 409);
  }
  if (accessToken === null) {
    return context.json({ error: "broadcast_identity_missing" }, 409);
  }

  const twitchUpdate = {
    ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
    ...(parsed.data.gameId === undefined ? {} : { game_id: parsed.data.gameId }),
  };
  const updateBroadcast = (token: string) => context.get("measureServerTiming")("helix", () => context.get("helixRequest")({
    url: "https://api.twitch.tv/helix/channels",
    query: { broadcaster_id: channelId },
    accessToken: token,
    clientId: context.env.TWITCH_CLIENT_ID,
    method: "PATCH",
    body: twitchUpdate,
  }));
  if (!await managementStillAuthorized()) return context.json({ error: "broadcast_manage_denied" }, 403);
  let result = await updateBroadcast(accessToken);
  if (!result.ok) {
    if (result.status === 401) {
      try {
        const refreshedIdentity = await refreshLoginIdentityTokens(context.env, identity, nowIso());
        if (refreshedIdentity === null || refreshedIdentity.status !== "connected") {
          return context.json({ error: "broadcast_identity_missing" }, 409);
        }
        identity = refreshedIdentity;
        if (!loginIdentityHasBroadcastScope(identity)) return context.json({ error: "broadcast_scope_missing" }, 403);
        const refreshedToken = await decryptLoginIdentityAccessToken(identity, context.env);
        if (refreshedToken === null) return context.json({ error: "broadcast_identity_missing" }, 409);
        if (!await managementStillAuthorized()) return context.json({ error: "broadcast_manage_denied" }, 403);
        result = await updateBroadcast(refreshedToken);
      } catch {
        return context.json({ error: "broadcast_update_failed" }, 502);
      }
    }
    if (!result.ok) {
      if (result.status === 403) return context.json({ error: "broadcast_scope_missing" }, 403);
      return context.json({ error: "broadcast_update_failed" }, 502);
    }
  }

  const actor = context.get("actor");
  const updatedAt = nowIso();
  const changed = parsed.data;
  await recordAudit(context.env.DB, actor.userId, updatedAt, channelId, null, "channel.broadcast.updated", null, changed);
  return context.body(null, 204);
});

moduleRouter.get("/api/channels/:channelId/template-variables", async (context) => {
  const channelId = context.req.param("channelId");
  const [moduleVariables, channelVariables] = await Promise.all([
    context.get("listRegisteredTemplateVariables")(channelId),
    context.get("listChannelVariables")(channelId),
  ]);
  const variables = effectiveEventTemplateDeclarations([
    ...SYSTEM_TEMPLATE_VARIABLE_LIST.map((variable) => ({ ...variable, moduleId: "host", isTextBlock: false })),
    ...moduleVariables,
    ...channelVariables.map((variable) => ({
      name: `var.${variable.name}`,
      moduleId: "host",
      isTextBlock: false,
      description: variable.description,
      group: "channel" as const,
      sample: String(variable.value),
      maxLength: 10,
      source: "channel" as const,
    })),
  ]);
  return context.json({ variables, defaultTimeZone: DEFAULT_CHANNEL_TIME_ZONE });
});

moduleRouter.post("/api/channels/:channelId/template-preview", async (context) => {
  const parsed = previewSchema.safeParse(await readJsonBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "template_preview_invalid" }, 400);
  const channelId = context.req.param("channelId");
  const now = Date.now();
  const game = parsed.data.game;
  const streamState: ModuleStreamState = parsed.data.streamState;
  const event: ModuleEvent = {
    channelId,
    subscriptionType: "channel.chat.message",
    triggerId: "template-preview",
    payload: { chatter_user_login: "viewer", chatter_user_name: "Viewer", broadcaster_user_login: channelId },
    settings: {},
    receivedAt: new Date(now).toISOString(),
    actor: { userId: "template-preview-viewer", login: "viewer", role: null },
    chatStatus: parsed.data.chatStatus,
  };
  const render = await createSimulatedTemplateRenderer(context.env, channelId, {
    event,
    templateContext: parsed.data.templateContext,
    streamState,
    game,
    now,
  }, {
    externalFetchBudget: context.get("externalFetchBudget"),
    runModuleAlarm: (moduleId, handlerKey, alarmKey, invocation) => {
      const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
      return invocation === undefined
        ? object.runModuleAlarm(moduleId, handlerKey, alarmKey)
        : object.runModuleAlarm(moduleId, handlerKey, alarmKey, invocation);
    },
  });
  const textCommands = {
    args: parsed.data.templateContext === "chat_command" ? "viewer input" : "",
    target: "viewer",
    command: "preview",
  };
  return context.json(await render(parsed.data.text, textCommands, undefined, "preview"));
});

moduleRouter.get("/api/channels/:channelId/modules", async (context) => {
  const channelId = context.req.param("channelId");
  return context.json({ modules: await measureServerTiming(context, "d1", () => getPanelModuleStates(context.env.DB, channelId)) });
});

moduleRouter.get("/api/channels/:channelId/modules/:moduleId/settings", async (context) => {
  const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
  if (module === undefined) return context.json({ error: "module_unknown" }, 404);
  const stored = await getChannelModuleForChannel(context.env.DB, context.req.param("channelId"), module.id);
  if (stored === null) return context.json({ error: "module_not_configured" }, 404);
  let rawSettings: unknown;
  try {
    rawSettings = JSON.parse(stored.settings);
  } catch {
    return context.json({ error: "module_settings_invalid" }, 500);
  }
  const settings = module.settingsSchema.safeParse(rawSettings);
  if (!settings.success) return context.json({ error: "module_settings_invalid" }, 500);
  const channelId = context.req.param("channelId");
  const variables = (await listChannelVariables(context.env.DB, channelId)).map(({ name, value, description }) => ({ name, value, description }));
  return context.json({ settings: settings.data, revision: stored.settingsRevision, variables });
});

moduleRouter.patch("/api/channels/:channelId/modules/:moduleId/settings", async (context) => {
  if (!canManageModules(context.get("channelRole"))) return manageDenied(context);
  const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
  if (module === undefined) return context.json({ error: "module_unknown" }, 404);
  const channelId = context.req.param("channelId");
  const stored = await getChannelModuleForChannel(context.env.DB, channelId, module.id);
  if (stored === null) return context.json({ error: "module_not_configured" }, 404);
  if (module.id === "clips" && !stored.enabled) return context.json({ error: "module_disabled" }, 409);
  const body = await readJsonBody(context.req.raw);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return context.json({
    error: "module_settings_invalid",
    path: "settings",
    reasonCode: "settings_payload_invalid",
    reason: "Settings data and revision are required.",
  }, 400);
  if (!Number.isSafeInteger(Reflect.get(body, "revision")) || (Reflect.get(body, "revision") as number) < 1) return context.json({
    error: "module_settings_invalid",
    path: "revision",
    reasonCode: "settings_revision_invalid",
    reason: "A valid settings revision is required.",
  }, 400);
  const expectedRevision = Reflect.get(body, "revision") as number;
  const hasStatsUrl = Reflect.has(body, "statsUrl");
  const hasRemoveStatsUrl = Reflect.has(body, "removeStatsUrl");
  const removeStatsUrl = module.id === BELABOX_MODULE_ID && Reflect.get(body, "removeStatsUrl") === true;
  if (module.id !== BELABOX_MODULE_ID && (hasStatsUrl || hasRemoveStatsUrl)) return context.json({ error: "module_settings_invalid" }, 400);
  if (hasRemoveStatsUrl && !removeStatsUrl) return context.json({ error: "module_settings_invalid" }, 400);
  if (removeStatsUrl && hasStatsUrl) return context.json({ error: "module_settings_invalid" }, 400);
  let statsUrl: string | undefined;
  if (hasStatsUrl) {
    const submittedUrl = Reflect.get(body, "statsUrl");
    if (typeof submittedUrl !== "string") return context.json({ error: "belabox_stats_url_invalid" }, 400);
    const validation = validateBelaboxStatsUrl(submittedUrl);
    if (!validation.ok) return context.json({ error: `belabox_stats_url_${validation.reason}` }, 400);
    statsUrl = validation.url.href;
  }
  let settingsInput = Reflect.get(body, "settings");
  if (settingsInput === undefined) {
    if (!removeStatsUrl) return context.json({
      error: "module_settings_invalid",
      path: "settings",
      reasonCode: "settings_payload_invalid",
      reason: "Settings data and revision are required.",
    }, 400);
    try {
      settingsInput = JSON.parse(stored.settings) as unknown;
    } catch {
      return context.json({ error: "module_settings_invalid" }, 500);
    }
  }
  const settings = module.settingsSchema.safeParse(settingsInput);
  if (!settings.success) {
    const issue = settings.error.issues[0];
    const path = issue === undefined || issue.path.length === 0
      ? "settings"
      : `settings.${issue.path.map(String).join(".")}`;
    const templateField = typeof issue?.path[0] === "string" && Object.hasOwn(module.templateFields ?? {}, issue.path[0]);
    return context.json({
      error: "module_settings_invalid",
      path,
      reasonCode: issue === undefined ? "settings_invalid" : issue.code === "custom" && templateField ? "template_text_invalid" : issue.code,
      reason: issue?.message ?? "Settings do not match the module schema.",
    }, 400);
  }
  const semanticError = module.validateSettings?.(settings.data);
  if (semanticError !== undefined && semanticError !== null) return context.json({ error: semanticError }, 400);
  if (module.id === "clips") {
    let rawStoredSettings: unknown;
    try {
      rawStoredSettings = JSON.parse(stored.settings);
    } catch {
      return context.json({ error: "module_settings_invalid" }, 500);
    }
    const storedSettings = module.settingsSchema.safeParse(rawStoredSettings);
    if (!storedSettings.success) return context.json({ error: "module_settings_invalid" }, 500);
    const lockedFields = [
      "automaticClipsEnabled",
      "automaticThresholdMultiplier",
      "automaticCooldownSeconds",
    ] as const;
    const storedRecord = storedSettings.data as Readonly<Record<string, unknown>>;
    const submittedRecord = settings.data as Readonly<Record<string, unknown>>;
    const changedLockedFields = lockedFields.filter((field) => !Object.is(storedRecord[field], submittedRecord[field]));
    if (changedLockedFields.length > 0) return context.json({ error: "clip_settings_locked", fields: changedLockedFields }, 409);
  }
  const graphRevision = await readTextBlockGraphRevision(context.env.DB, channelId);
  const settingsRecord = settings.data as Readonly<Record<string, unknown>>;
  const templateTexts = Object.keys(module.templateFields ?? {}).flatMap((field) => {
    const value = settingsRecord[field];
    return typeof value === "string" ? [value] : [];
  });
  const blockGuard = textBlockWriteGuard(channelId, graphRevision, templateTexts);
  const channelVariables = (await listChannelVariables(context.env.DB, channelId)).map((variable) => ({
    name: `var.${variable.name}`, group: "channel" as const, sample: String(variable.value), maxLength: 10, source: "channel" as const,
  }));
  const registeredVariables = (await context.get("listRegisteredTemplateVariables")(channelId)).map((variable) => variable.name);
  const warnings = module.templateFields === undefined ? [] : Object.entries(module.templateFields).flatMap(([field, variables]) => {
    const value = (settings.data as Readonly<Record<string, unknown>>)[field];
    if (typeof value !== "string") return [];
    const effective = effectiveTemplateVariables(module.templateContext ?? "event", (variables ?? []) as readonly TemplateVariable[], channelVariables, SYSTEM_TEMPLATE_VARIABLE_LIST);
    return templateWarnings(field, value, effective, registeredVariables);
  });
  const changedAt = nowIso();
  let dependentMutations: D1PreparedStatement[] = [];
  if (statsUrl !== undefined || removeStatsUrl) {
    const secretAccess = context.get("secrets")(channelId);
    const actor = actorOf(context);
    const secretMutation = statsUrl === undefined
      ? secretAccess.prepareDelete(BELABOX_STATS_URL_SECRET, actor, changedAt, true)
      : await secretAccess.prepareWrite(BELABOX_STATS_URL_SECRET, statsUrl, actor, changedAt, true);
    const secretAudit = context.get("prepareModuleAudit")({
      channelId,
      moduleId: BELABOX_MODULE_ID,
      action: statsUrl === undefined ? "module.secret.removed" : "module.secret.replaced",
      before: statsUrl === undefined ? { statsUrl: "configured" } : null,
      after: statsUrl === undefined ? { statsUrl: "removed" } : { statsUrl: "replaced" },
    }, changedAt);
    dependentMutations = [secretMutation, secretAudit];
  }
  const changed = await updateChannelModuleSettingsWithAudit(
    context.env.DB,
    actorOf(context),
    channelId,
    module.id,
    JSON.stringify(settings.data),
    `${module.id}.settings_changed`,
    changedAt,
    dependentMutations,
    expectedRevision,
    blockGuard.references.length === 0 ? undefined : blockGuard,
    module.id === "clips",
  );
  if (!changed) {
    const current = await getChannelModuleForChannel(context.env.DB, channelId, module.id);
    let currentSettings: unknown = null;
    if (current !== null) {
      try {
        const parsed: unknown = JSON.parse(current.settings);
        const validated = module.settingsSchema.safeParse(parsed);
        currentSettings = validated.success ? validated.data : null;
      } catch {
        currentSettings = null;
      }
    }
    return context.json({
      error: "module_settings_changed_concurrently",
      current: current === null ? null : { settings: currentSettings, revision: current.settingsRevision },
    }, 409);
  }
  if (module.id === BELABOX_MODULE_ID && (statsUrl !== undefined || removeStatsUrl)) {
    await resetSampleAfterStatsUrlChangeBestEffort(
      context.get("runModuleAlarm"),
      context.get("writeModuleDiagnostics"),
      context.env.DB,
      channelId,
    );
  }
  if (module.settingsChangedAlarm !== undefined) {
    await runModuleAlarmAfterMutation(
      context,
      channelId,
      module.id,
      module.settingsChangedAlarm.handlerKey,
      module.settingsChangedAlarm.alarmKey,
    );
  }
  return context.json({ settings: settings.data, revision: expectedRevision + 1, warnings });
});

moduleRouter.patch("/api/channels/:channelId/modules/:moduleId", async (context) => {
  if (!canManageModules(context.get("channelRole"))) return manageDenied(context);

  const moduleId = context.req.param("moduleId");
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  if (module === undefined) return context.json({ error: "module_unknown" }, 404);

  const body = await readJsonBody(context.req.raw);
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") return context.json({ error: "module_enabled_field_invalid" }, 400);
  const expectedRevision = body?.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)) {
    return context.json({ error: "module_revision_invalid" }, 400);
  }
  if (module.mandatory === true && !enabled) return context.json({ error: "module_mandatory" }, 400);

  const channelId = context.req.param("channelId");
  const channelLanguage = module.defaultSettingsForLanguage === undefined
    ? "en"
    : (await context.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
      .bind(context.req.param("channelId")).first<{ language: ModuleLanguage }>())?.language ?? "de";
  const defaultSettingsJson = JSON.stringify(module.defaultSettingsForLanguage?.(channelLanguage) ?? module.defaultSettings);
  const now = nowIso();
  const action: AuditAction = enabled ? "module.enabled" : "module.disabled";
  const actor = actorOf(context);

  const existing = await getChannelModuleForChannel(context.env.DB, channelId, moduleId);
  const requiredModules = enabled ? module.requiresModules ?? [] : [];
  const dependentModules = !enabled
    ? MODULES.filter((candidate) => candidate.requiresModules?.includes(moduleId)).map((candidate) => candidate.id)
    : [];
  const stateGuard = requiredModules.length > 0
    ? {
      sql: requiredModules.map(() => `AND EXISTS (
        SELECT 1 FROM channel_modules AS required_module
         WHERE required_module.channel_id = ? AND required_module.module_id = ? AND required_module.enabled = 1
      )`).join(" "),
      values: requiredModules.flatMap((requiredModule) => [channelId, requiredModule]),
    }
    : dependentModules.length > 0
      ? {
        sql: `AND NOT EXISTS (
          SELECT 1 FROM channel_modules AS dependent_module
           WHERE dependent_module.channel_id = ? AND dependent_module.enabled = 1
             AND dependent_module.module_id IN (${dependentModules.map(() => "?").join(", ")})
        )`,
        values: [channelId, ...dependentModules],
      }
      : undefined;
  const retryingPostCommit = existing !== null && existing.enabled === enabled && expectedRevision !== undefined &&
    Number(expectedRevision) + 1 === existing.revision;
  const initialize = enabled && existing?.initialized !== true;
  let dependentMutations: readonly D1PreparedStatement[] = [];
  if (initialize && module.onEnable !== undefined) {
    dependentMutations = await module.onEnable({
      DB: context.env.DB,
      authorizeMutation: context.get("authorizeManagementMutation"),
      prepareModuleAudit: context.get("prepareModuleAudit"),
      actor,
      now,
    }, channelId) ?? [];
  }
  const settings = existing === null ? defaultSettingsJson : existing.settings;
  let revision: number | null;
  let lastDisabledRevision = existing?.lastDisabledRevision ?? null;
  if (existing === null && enabled) {
    if (expectedRevision !== undefined) return context.json({ error: "module_changed_concurrently" }, 409);
    revision = await createChannelModuleWithAudit(
      context.env.DB,
      actor,
      { channelId, moduleId, enabled, settings },
      action,
      now,
      dependentMutations,
      stateGuard,
    );
  } else if (existing !== null) {
    if (retryingPostCommit) revision = existing.revision;
    else {
      const activation = await updateChannelModuleEnabledStateWithAudit(
        context.env.DB,
        actor,
        channelId,
        moduleId,
        enabled,
        action,
        now,
        dependentMutations,
        expectedRevision === undefined ? existing.revision : Number(expectedRevision),
        initialize,
        stateGuard,
      );
      revision = activation?.revision ?? null;
      lastDisabledRevision = activation?.lastDisabledRevision ?? null;
    }
  } else {
    return context.json({ error: "module_changed_concurrently" }, 409);
  }
  if (revision === null) {
    if (enabled && requiredModules.length > 0) {
      const placeholders = requiredModules.map(() => "?").join(", ");
      const enabledCount = await context.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM channel_modules
          WHERE channel_id = ? AND module_id IN (${placeholders}) AND enabled = 1`,
      ).bind(channelId, ...requiredModules).first<{ count: number }>();
      if ((enabledCount?.count ?? 0) !== requiredModules.length) return context.json({ error: "module_requires" }, 409);
    }
    if (!enabled && dependentModules.length > 0) {
      const placeholders = dependentModules.map(() => "?").join(", ");
      const requiredBy = await context.env.DB.prepare(
        `SELECT 1 AS found FROM channel_modules
          WHERE channel_id = ? AND module_id IN (${placeholders}) AND enabled = 1 LIMIT 1`,
      ).bind(channelId, ...dependentModules).first<{ found: number }>();
      if (requiredBy !== null) return context.json({ error: "module_required_by" }, 409);
    }
    return context.json({ error: "module_changed_concurrently" }, 409);
  }
  if ((module.requiresModules?.length ?? 0) > 0 || module.id === "points") {
    try {
      const points = context.get("points")(channelId);
      await points.rounds.setGate(!enabled, revision, lastDisabledRevision);
      if (!enabled && (module.requiresModules?.length ?? 0) > 0) {
        await points.rounds.cancelOpenRounds(revision);
      }
    } catch {
      return context.json({ error: "module_gate_update_failed" }, 500);
    }
  }
  if (module.id === "belabox" && module.settingsChangedAlarm !== undefined) {
    await runModuleAlarmAfterMutation(
      context,
      channelId,
      module.id,
      module.settingsChangedAlarm.handlerKey,
      module.settingsChangedAlarm.alarmKey,
    );
  } else if (enabled && existing?.enabled !== true) {
    await notifyModuleScheduleInputsChanged(context.env.CHANNEL, channelId, "activation");
  }
  const overlayKinds = module.overlayElements?.map(({ kind }) => kind) ?? [];
  if (overlayKinds.length > 0) {
    const placeholders = overlayKinds.map(() => "?").join(", ");
    const affectedOverlays = await context.env.DB.prepare(
      `SELECT DISTINCT overlay.overlay_id, overlay.revision
         FROM overlays AS overlay
         JOIN overlay_elements AS element
           ON element.channel_id = overlay.channel_id AND element.overlay_id = overlay.overlay_id
        WHERE overlay.channel_id = ? AND element.kind IN (${placeholders})
        ORDER BY overlay.overlay_id`,
    ).bind(channelId, ...overlayKinds).all<{ overlay_id: string; revision: number }>();
    await publishOverlayChanged(context.env.CHANNEL, channelId, affectedOverlays.results.map(({ overlay_id, revision }) => ({
      overlayId: overlay_id,
      revision,
    })));
  }
  try {
    await maintainEventSubSubscriptions(context.env, now, fetch, channelId);
  } catch {
    // The reconciliation writes the error state itself; the module change remains successful.
  }
  return context.json({
    module: await moduleStateFor(context.env.DB, channelId, module, enabled, settings),
    revision,
  });
});

for (const module of MODULES) {
  if (module.routes !== undefined) {
    moduleRouter.route(`/api/channels/:channelId/modules/${module.id}`, module.routes);
  }
}
