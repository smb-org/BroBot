import { Hono } from "hono";
import { z } from "zod";

import {
  createChannelModuleWithAudit,
  getChannelModuleForChannel,
  updateChannelModuleWithAudit,
} from "../db/channel-modules";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import { canManage, type AuditAction } from "../../contracts/values";
import type { ModuleChannelInfo, ModuleChannelVariable, ModuleEvent, ModuleExternalFetchBudget, ModuleLanguage, ModuleOverlayHostEvent, ModuleRegisteredTemplateVariable, ModuleRouteVariables, ModuleStreamState, ModuleTemplateConditionContext } from "../../modules/contract";
import { MODULES, templateVariableGroupForModule, validateModuleTemplateVariable, variablesForModuleTemplateContext } from "../../modules/registry";
import type { PanelModuleState } from "../../panel-contract";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { moduleBroadcasterScopeState } from "../module-scopes";
import { getPanelModuleStates } from "./module-repository";
import { actorOf, readJsonBody } from "./member-routes";
import { broadcasterHasScope, broadcasterScopesForChannel } from "../broadcaster-scope";
import { getAppAccessToken } from "../app-token";
import { writeModuleDiagnostics } from "../event-log";
import { helixRequest } from "../twitch/helix";
import { readChannelBlockedTerms } from "../twitch/blocked-terms";
import { effectiveTemplateVariables, templateWarnings, type TemplateVariable } from "../../template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../template-variables";
import { listChannelVariables } from "../db/channel-variables";
import { findChannelVariable } from "../db/channel-variables";
import { measureServerTiming, recordServerTiming, scheduleBackgroundWork } from "../server-timing";
import { publishOverlayChanged, publishOverlayHostEvent as publishOverlayHostEventHint, publishRealtimeMessages } from "../realtime";
import { prepareModuleOverlayRealtimeMessage } from "../module-overlay-realtime";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../../modules/contract";
import { readChannelVariables } from "../db/channel-variables";
import { readChannelLocation } from "../db/channel-settings";
import { createTemplateRenderer, type TemplateValueProvider } from "../template-resolver";
import { moduleEventTimeOptions, resolveModuleEventTimes } from "../module-event-times";
import { notifyModuleScheduleInputsChanged } from "../module-schedules";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
import { moduleBallots } from "../module-ballots";
import { createModuleSecretAccess, createModuleSecretReadAccess } from "../module-secrets";
import { liftModerationBan } from "../moderation";

interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables & Pick<
    ModuleRouteVariables,
    "writeModuleDiagnostics" | "broadcasterHasScope" | "broadcasterScopesForChannel"
    | "measureServerTiming" | "recordServerTiming" | "scheduleBackgroundWork" | "getAppAccessToken" | "helixRequest"
    | "listChannelVariables" | "findChannelVariable" | "secrets"
    | "externalFetchBudget"
    | "ballots"
    | "readChannelBlockedTerms"
    | "runModuleAlarm"
    | "listTextBlockConditions"
    | "listEventTimeSources" | "resolveEventTimes"
    | "notifyScheduleInputsChanged" | "validateTemplateContentMutation"
    | "resolveTextBlockConditions"
    | "publishModuleOverlayMessage"
    | "publishOverlayHostEvent"
    | "templateUsageSources" | "listRegisteredTemplateVariables"
    | "liftModerationBan"
  >;
}

const nowIso = (): string => new Date().toISOString();
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
  text: z.string().max(500),
  templateContext: z.enum(["event", "chat_command"]),
  streamState: z.enum(["online", "offline", "unknown"]),
  game: z.object({ id: z.string().regex(/^[0-9]{1,20}$/u), name: z.string().trim().max(100) }).nullable(),
  chatStatus: z.array(z.enum(["viewer", "subscriber", "vip", "moderator", "broadcaster"])).nullable(),
});

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

export const registeredTemplateVariablesForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<readonly ModuleRegisteredTemplateVariable[]> => {
  const registrations = await Promise.all(MODULES.map(async (module) => {
    const fields = Object.values(module.templateFields ?? {})
      .flatMap((variables) => variables ?? []) as TemplateVariable[];
    const dynamic = await module.templateVariables?.(db, channelId) ?? [];
    const catalog = new Map((module.templateVariableCatalog ?? []).map((variable) => [variable.name, variable]));
    const declarations = new Map<string, TemplateVariable>();
    for (const variable of [...(module.templateVariableCatalog ?? []), ...fields, ...dynamic]) {
      declarations.set(variable.name, { ...declarations.get(variable.name), ...variable });
    }
    return variablesForModuleTemplateContext(module, [...declarations.values()]).map((variable) => {
      validateModuleTemplateVariable(module, variable.name);
      const pickerGroup = templateVariableGroupForModule(module);
      const picker = variable.picker ?? catalog.get(variable.name)?.picker;
      if (module.templateVariableNamespace !== "text_blocks" && module.templateVariableGroup !== undefined &&
          (picker === undefined || pickerGroup === undefined)) {
        throw new Error(`Module template variable ${module.id}.${variable.name} is missing picker copy or source group metadata.`);
      }
      return {
        ...variable,
        ...(picker === undefined ? {} : { picker }),
        moduleId: module.id,
        isTextBlock: module.templateVariableNamespace === "text_blocks",
        ...(pickerGroup === undefined ? {} : { pickerGroup }),
      };
    });
  }));
  return registrations.flat();
};

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
  context.set("validateTemplateContentMutation", async (channelId, candidate) => {
    const registeredVariables = await registeredTemplateVariablesForChannel(context.env.DB, channelId);
    const validationContext = { DB: context.env.DB, channelId, candidate, registeredVariables };
    const issues = await Promise.all(MODULES.map((module) =>
      module.validateTemplateContent?.(validationContext) ?? Promise.resolve([]),
    ));
    return issues.flat();
  });
  context.set("resolveTextBlockConditions", async (channelId, ids, now) => {
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
      `SELECT overlay.name AS overlay_name, element.label, element.text, element.config_json
         FROM overlay_elements AS element JOIN overlays AS overlay
           ON overlay.channel_id = element.channel_id AND overlay.overlay_id = element.overlay_id
        WHERE element.channel_id = ? ORDER BY overlay.name, element.label`,
    ).bind(channelId).all<{ overlay_name: string; label: string; text: string; config_json: string }>();
    return [
      ...moduleSources.flat(),
      ...overlayRows.results.map((row) => ({
        text: `${row.text} ${row.config_json}`,
        kind: "overlay" as const,
        label: row.label || row.overlay_name,
      })),
    ];
  });
  return next();
});

moduleRouter.use("/api/channels/:channelId/games", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/template-variables", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/template-preview", requireChannelAuthorization());

moduleRouter.get("/api/channels/:channelId/games", async (context) => {
  const query = (context.req.query("q") ?? "").trim();
  if (query.length < 2 || query.length > 100) return context.json({ games: [] });
  try {
    const token = await context.get("measureServerTiming")("helix", () =>
      context.get("getAppAccessToken")(context.env, nowIso()),
    );
    const result = await context.get("measureServerTiming")("helix", () => context.get("helixRequest")<{
      data?: readonly { id?: unknown; name?: unknown; box_art_url?: unknown }[];
    }>({
      url: "https://api.twitch.tv/helix/search/categories",
      query: { query, first: "20" },
      accessToken: token,
      clientId: context.env.TWITCH_CLIENT_ID,
    }));
    if (!result.ok || !Array.isArray(result.data.data)) return context.json({ error: "games_unavailable" }, 503);
    const entries = result.data.data as unknown as readonly unknown[];
    const games = entries.flatMap((entry): { id: string; name: string; boxArtUrlTemplate?: string }[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const name = record.name;
      if (typeof id !== "string" || typeof name !== "string") return [];
      const boxArtUrlTemplate = record.box_art_url;
      if (typeof boxArtUrlTemplate !== "string") return [{ id, name }];
      try {
        const parsedUrl = new URL(boxArtUrlTemplate.replaceAll("{width}", "100").replaceAll("{height}", "100"));
        if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "static-cdn.jtvnw.net") return [{ id, name }];
      } catch {
        return [{ id, name }];
      }
      return [{ id, name, boxArtUrlTemplate }];
    });
    return context.json({ games });
  } catch {
    return context.json({ error: "games_unavailable" }, 503);
  }
});

moduleRouter.get("/api/channels/:channelId/template-variables", async (context) => {
  const channelId = context.req.param("channelId");
  const [moduleVariables, channelVariables] = await Promise.all([
    context.get("listRegisteredTemplateVariables")(channelId),
    context.get("listChannelVariables")(channelId),
  ]);
  const variables = [
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
  ];
  const unique = new Map(variables.map((variable) => [variable.name, variable]));
  return context.json({ variables: [...unique.values()], defaultTimeZone: DEFAULT_CHANNEL_TIME_ZONE });
});

moduleRouter.post("/api/channels/:channelId/template-preview", async (context) => {
  const parsed = previewSchema.safeParse(await readJsonBody(context.req.raw));
  if (!parsed.success) return context.json({ error: "template_preview_invalid" }, 400);
  const channelId = context.req.param("channelId");
  const [registeredVariables, channelSettings, channelLanguage] = await Promise.all([
    context.get("listRegisteredTemplateVariables")(channelId),
    context.env.DB.prepare("SELECT time_zone FROM channels WHERE channel_id = ?").bind(channelId).first<{ time_zone: string }>(),
    context.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?").bind(channelId).first<{ language: ModuleLanguage }>(),
  ]);
  const providerVariables = new Map(MODULES.map((module) => [
    module.id,
    registeredVariables.filter((variable) => variable.moduleId === module.id),
  ]));
  const providerConditions = new Map(await Promise.all(MODULES.map(async (module) => [
    module.id,
    [
      ...(module.textBlockConditions ?? []),
      ...(await module.textBlockConditionsForChannel?.(context.env.DB, channelId) ?? []),
    ],
  ] as const)));
  const templateValueProviders: TemplateValueProvider[] = MODULES.flatMap((module) => {
    const resolveTemplateValues = module.resolveTemplateValues;
    if (resolveTemplateValues === undefined && module.resolveTemplateParameter === undefined) return [];
    const variables = providerVariables.get(module.id) ?? [];
    return [{
      moduleId: module.id,
      ...(module.templateVariableNamespace === undefined ? {} : { templateVariableNamespace: module.templateVariableNamespace }),
      variables,
      textBlockConditions: providerConditions.get(module.id) ?? [],
      ...(module.templateUnavailableText === undefined ? {} : { templateUnavailableText: module.templateUnavailableText }),
      ...(module.resolveTemplateConditions === undefined ? {} : { resolveTemplateConditions: module.resolveTemplateConditions }),
      ...(module.dynamicTemplateVariableNames === undefined ? {} : { dynamicTemplateVariableNames: module.dynamicTemplateVariableNames }),
      ...(module.resolveOverlayTemplateValues === undefined ? {} : { resolveOverlayTemplateValues: module.resolveOverlayTemplateValues }),
      ...(module.resolveTemplateConditionTransitions === undefined ? {} : { resolveTemplateConditionTransitions: module.resolveTemplateConditionTransitions }),
      ...(resolveTemplateValues === undefined ? {} : { resolveTemplateValues }),
      ...(module.resolveTemplateParameter === undefined ? {} : { resolveTemplateParameter: module.resolveTemplateParameter }),
    }];
  });
  const registeredTemplateVariables = registeredVariables.filter((variable) => {
    return !variable.isTextBlock &&
      (variable.contexts?.includes(parsed.data.templateContext) ?? true);
  });
  const now = Date.now();
  const game = parsed.data.game;
  const streamState: ModuleStreamState = parsed.data.streamState;
  const channelInfo: ModuleChannelInfo = {
    title: "",
    gameName: game?.name ?? "",
    gameId: game?.id ?? "",
    startedAt: streamState === "online" ? new Date(now).toISOString() : null,
    viewerCount: 0,
  };
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
  // The preview has no simulated module of its own (text blocks declare no local
  // variables), so pass none here — otherwise other modules' local declarations
  // (e.g. raid's event-scoped "viewers"/"channel") would shadow the host system
  // variables in every preview. The full registry stays available below for
  // value-provider discovery only.
  const render = createTemplateRenderer(event, parsed.data.templateContext, [], {
    DB: context.env.DB,
    moduleSecrets: (moduleId) => createModuleSecretReadAccess(context.env, channelId, moduleId),
    externalFetchBudget: context.get("externalFetchBudget"),
    runModuleAlarm: (moduleId, handlerKey, alarmKey, invocation) => {
      const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
      return invocation === undefined
        ? object.runModuleAlarm(moduleId, handlerKey, alarmKey)
        : object.runModuleAlarm(moduleId, handlerKey, alarmKey, invocation);
    },
    publicOrigin: context.env.PUBLIC_ORIGIN,
    channelInfo: () => Promise.resolve(channelInfo),
    channelGameId: () => Promise.resolve(game?.id ?? null),
    channelTimeZone: () => Promise.resolve(channelSettings === null ? DEFAULT_CHANNEL_TIME_ZONE : channelSettings.time_zone),
    channelLocation: () => readChannelLocation(context.env.DB, channelId),
    templateValueProviders,
    registeredTemplateVariables,
    streamState: () => Promise.resolve(streamState),
    channelDetails: () => Promise.resolve({ title: channelInfo.title, gameName: channelInfo.gameName, gameId: channelInfo.gameId }),
    streamDetails: () => Promise.resolve({ startedAt: channelInfo.startedAt, viewerCount: channelInfo.viewerCount }),
    followedAt: () => Promise.resolve("unavailable"),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve(channelLanguage?.language === "en" ? "en" : "de"),
    readChannelVariables: (names) => readChannelVariables(context.env.DB, channelId, names),
    now: () => now,
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
  return context.json({ settings: settings.data, revision: stored.revision, variables });
});

moduleRouter.patch("/api/channels/:channelId/modules/:moduleId/settings", async (context) => {
  if (!canManageModules(context.get("channelRole"))) return manageDenied(context);
  const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
  if (module === undefined) return context.json({ error: "module_unknown" }, 404);
  const channelId = context.req.param("channelId");
  const stored = await getChannelModuleForChannel(context.env.DB, channelId, module.id);
  if (stored === null) return context.json({ error: "module_not_configured" }, 404);
  const body = await readJsonBody(context.req.raw);
  if (body === null || typeof body !== "object" || Array.isArray(body) ||
      !Number.isSafeInteger(Reflect.get(body, "revision")) || (Reflect.get(body, "revision") as number) < 1) {
    return context.json({ error: "module_settings_invalid" }, 400);
  }
  const expectedRevision = Reflect.get(body, "revision") as number;
  const settings = module.settingsSchema.safeParse(Reflect.get(body, "settings"));
  if (!settings.success) return context.json({ error: "module_settings_invalid" }, 400);
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
  const changed = await updateChannelModuleWithAudit(
    context.env.DB,
    actorOf(context),
    channelId,
    module.id,
    stored.enabled,
    JSON.stringify(settings.data),
    `${module.id}.settings_changed`,
    nowIso(),
    [],
    expectedRevision,
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
      current: current === null ? null : { settings: currentSettings, revision: current.revision },
    }, 409);
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
  if (module.mandatory === true && !enabled) return context.json({ error: "module_mandatory" }, 400);

  const channelId = context.req.param("channelId");
  const defaultSettingsJson = JSON.stringify(module.defaultSettings);
  const now = nowIso();
  const action: AuditAction = enabled ? "module.enabled" : "module.disabled";
  const actor = actorOf(context);

  const existing = await getChannelModuleForChannel(context.env.DB, channelId, moduleId);
  let dependentMutations: readonly D1PreparedStatement[] = [];
  if (enabled && module.onEnable !== undefined) {
    dependentMutations = await module.onEnable({
      DB: context.env.DB,
      authorizeMutation: context.get("authorizeManagementMutation"),
      prepareModuleAudit: context.get("prepareModuleAudit"),
      actor,
      now,
    }, channelId) ?? [];
  }
  const settings = existing === null || enabled ? defaultSettingsJson : existing.settings;
  const changed = existing === null
    ? await createChannelModuleWithAudit(
      context.env.DB,
      actor,
      { channelId, moduleId, enabled, settings },
      action,
      now,
      dependentMutations,
    )
    : await updateChannelModuleWithAudit(
      context.env.DB,
      actor,
      channelId,
      moduleId,
      enabled,
      settings,
      action,
      now,
      dependentMutations,
    );
  if (!changed) return context.json({ error: "module_changed_concurrently" }, 409);
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
  });
});

for (const module of MODULES) {
  if (module.routes !== undefined) {
    moduleRouter.route(`/api/channels/:channelId/modules/${module.id}`, module.routes);
  }
}
