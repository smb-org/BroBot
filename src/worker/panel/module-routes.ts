import { Hono } from "hono";

import {
  createChannelModuleWithAudit,
  getChannelModuleForChannel,
  listChannelModulesForChannel,
  updateChannelModuleWithAudit,
} from "../auth/repository";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import type { ChannelMemberRole } from "../auth/authorization";
import type { ModuleRouteVariables } from "../../modules/contract";
import { MODULES } from "../../modules/registry";
import type { PanelModuleState } from "../../panel-contract";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { moduleBroadcasterScopeState } from "../module-scopes";
import { actorOf, readJsonBody } from "./member-routes";
import { broadcasterHasScope } from "../broadcaster-scope";
import { getAppAccessToken } from "../app-token";
import { writeModuleDiagnostics } from "../event-log";

interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables & Pick<
    ModuleRouteVariables,
    "writeModuleDiagnostics" | "broadcasterHasScope" | "getAppAccessToken"
  >;
}

const nowIso = (): string => new Date().toISOString();

const canManageModules = (role: ChannelMemberRole): boolean => role !== "bediener";

const manageDenied = (context: { text: (body: string, status: 403) => Response }): Response =>
  context.text("Nur Broadcaster und Verwalter dürfen Module ändern.", 403);

const moduleState = (
  id: string,
  enabled: boolean,
  settings: string,
  requiredBroadcasterScopes: readonly string[] = [],
  missingBroadcasterScopes: readonly string[] = [],
): PanelModuleState => ({
  id,
  enabled,
  settings,
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
  return moduleState(module.id, enabled, settings, scopes.required, scopes.missing);
};

export const moduleRouter = new Hono<ModuleRouteEnvironment>();

moduleRouter.use("/api/channels/:channelId/modules", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/modules/*", requireChannelAuthorization());

moduleRouter.use("/api/channels/:channelId/modules/*", (context, next) => {
  context.set("writeModuleDiagnostics", writeModuleDiagnostics);
  context.set("broadcasterHasScope", broadcasterHasScope);
  context.set("getAppAccessToken", getAppAccessToken);
  return next();
});

moduleRouter.get("/api/channels/:channelId/modules", async (context) => {
  const channelId = context.req.param("channelId");
  const stored = await listChannelModulesForChannel(context.env.DB, channelId);
  const storedById = new Map(stored.map((entry) => [entry.moduleId, entry]));
  const modules: PanelModuleState[] = await Promise.all(MODULES.map(async (module) => {
    const existing = storedById.get(module.id);
    return moduleStateFor(
      context.env.DB,
      channelId,
      module,
      existing?.enabled ?? false,
      existing?.settings ?? JSON.stringify(module.defaultSettings),
    );
  }));
  return context.json({ modules });
});

moduleRouter.get("/api/channels/:channelId/modules/:moduleId/einstellungen", async (context) => {
  const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
  if (module === undefined) return context.text("Unbekanntes Modul.", 404);
  const stored = await getChannelModuleForChannel(context.env.DB, context.req.param("channelId"), module.id);
  if (stored === null) return context.text("Modul ist in diesem Kanal nicht eingerichtet.", 404);
  let rawSettings: unknown;
  try {
    rawSettings = JSON.parse(stored.settings);
  } catch {
    return context.text("Moduleinstellungen sind ungültig.", 500);
  }
  const settings = module.settingsSchema.safeParse(rawSettings);
  return settings.success ? context.json({ settings: settings.data }) : context.text("Moduleinstellungen sind ungültig.", 500);
});

moduleRouter.patch("/api/channels/:channelId/modules/:moduleId/einstellungen", async (context) => {
  if (!canManageModules(context.get("channelRole"))) return manageDenied(context);
  const module = MODULES.find((candidate) => candidate.id === context.req.param("moduleId"));
  if (module === undefined) return context.text("Unbekanntes Modul.", 404);
  const channelId = context.req.param("channelId");
  const stored = await getChannelModuleForChannel(context.env.DB, channelId, module.id);
  if (stored === null) return context.text("Modul ist in diesem Kanal nicht eingerichtet.", 404);
  const settings = module.settingsSchema.safeParse(await readJsonBody(context.req.raw));
  if (!settings.success) return context.text("Moduleinstellungen sind ungültig.", 400);
  const changed = await updateChannelModuleWithAudit(
    context.env.DB,
    actorOf(context),
    channelId,
    module.id,
    stored.enabled,
    JSON.stringify(settings.data),
    `${module.id}.einstellungen_geaendert`,
    nowIso(),
  );
  if (!changed) return context.text("Moduleinstellungen wurden inzwischen geändert.", 409);
  return context.json({ settings: settings.data });
});

moduleRouter.patch("/api/channels/:channelId/modules/:moduleId", async (context) => {
  if (!canManageModules(context.get("channelRole"))) return manageDenied(context);

  const moduleId = context.req.param("moduleId");
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  if (module === undefined) return context.text("Unbekanntes Modul.", 404);

  const body = await readJsonBody(context.req.raw);
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") return context.text("Feld enabled ist ungültig.", 400);

  const channelId = context.req.param("channelId");
  const defaultSettingsJson = JSON.stringify(module.defaultSettings);
  const now = nowIso();
  const action = enabled ? "modul.aktiviert" : "modul.deaktiviert";
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
  if (!changed) return context.text("Modul wurde inzwischen geändert.", 409);
  try {
    await maintainEventSubSubscriptions(context.env, now, fetch, channelId);
  } catch {
    // Der Abgleich schreibt den Fehlerzustand selbst; die Moduländerung bleibt erfolgreich.
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
