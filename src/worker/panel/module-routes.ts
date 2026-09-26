import { Hono } from "hono";

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
import type { ModuleChannelVariable, ModuleRouteVariables } from "../../modules/contract";
import { MODULES } from "../../modules/registry";
import type { PanelModuleState } from "../../panel-contract";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { moduleBroadcasterScopeState } from "../module-scopes";
import { getPanelModuleStates } from "./module-repository";
import { actorOf, readJsonBody } from "./member-routes";
import { broadcasterHasScope, broadcasterScopesForChannel } from "../broadcaster-scope";
import { getAppAccessToken } from "../app-token";
import { writeModuleDiagnostics } from "../event-log";
import { helixRequest } from "../twitch/helix";
import { effectiveTemplateVariables, templateWarnings, type TemplateVariable } from "../../template";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../template-variables";
import { listChannelVariables } from "../db/channel-variables";
import { findChannelVariable } from "../db/channel-variables";
import { measureServerTiming, recordServerTiming, scheduleBackgroundWork } from "../server-timing";
import { publishOverlayChanged } from "../realtime";

interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables & Pick<
    ModuleRouteVariables,
    "writeModuleDiagnostics" | "broadcasterHasScope" | "broadcasterScopesForChannel"
    | "measureServerTiming" | "recordServerTiming" | "scheduleBackgroundWork" | "getAppAccessToken" | "helixRequest"
    | "listChannelVariables" | "findChannelVariable"
    | "templateUsageSources"
  >;
}

const nowIso = (): string => new Date().toISOString();

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

moduleRouter.use("/api/channels/:channelId/modules/*", (context, next) => {
  context.set("writeModuleDiagnostics", writeModuleDiagnostics);
  context.set("broadcasterHasScope", broadcasterHasScope);
  context.set("broadcasterScopesForChannel", broadcasterScopesForChannel);
  context.set("measureServerTiming", (phase, run) => measureServerTiming(context, phase, run));
  context.set("recordServerTiming", (phase, durationMs) => { recordServerTiming(context, phase, durationMs); });
  context.set("scheduleBackgroundWork", (work) => { scheduleBackgroundWork(context, work); });
  context.set("getAppAccessToken", getAppAccessToken);
  context.set("helixRequest", helixRequest);
  context.set("listChannelVariables", async (channelId): Promise<readonly ModuleChannelVariable[]> =>
    (await listChannelVariables(context.env.DB, channelId)).map(({ name, value, description }) => ({ name, value, description })),
  );
  context.set("findChannelVariable", async (channelId, name): Promise<ModuleChannelVariable | null> => {
    const variable = await findChannelVariable(context.env.DB, channelId, name);
    return variable === null ? null : { name: variable.name, value: variable.value, description: variable.description };
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
  const warnings = module.templateFields === undefined ? [] : Object.entries(module.templateFields).flatMap(([field, variables]) => {
    const value = (settings.data as Readonly<Record<string, unknown>>)[field];
    if (typeof value !== "string") return [];
    const effective = effectiveTemplateVariables(module.templateContext ?? "event", (variables ?? []) as readonly TemplateVariable[], channelVariables, SYSTEM_TEMPLATE_VARIABLE_LIST);
    return templateWarnings(field, value, effective);
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
