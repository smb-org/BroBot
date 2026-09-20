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
import { MODULES } from "../../modules/registry";
import type { PanelModuleState } from "../../panel-contract";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { actorOf, readJsonBody } from "./member-routes";

interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const nowIso = (): string => new Date().toISOString();

const canManageModules = (role: ChannelMemberRole): boolean => role !== "bediener";

const manageDenied = (context: { text: (body: string, status: 403) => Response }): Response =>
  context.text("Nur Broadcaster und Verwalter dürfen Module ändern.", 403);

const moduleState = (id: string, enabled: boolean, settings: string): PanelModuleState =>
  ({ id, enabled, settings });

export const moduleRouter = new Hono<ModuleRouteEnvironment>();

moduleRouter.use("/api/channels/:channelId/modules", requireChannelAuthorization());
moduleRouter.use("/api/channels/:channelId/modules/*", requireChannelAuthorization());

moduleRouter.get("/api/channels/:channelId/modules", async (context) => {
  const channelId = context.req.param("channelId");
  const stored = await listChannelModulesForChannel(context.env.DB, channelId);
  const storedById = new Map(stored.map((entry) => [entry.moduleId, entry]));
  const modules: PanelModuleState[] = MODULES.map((module) => {
    const existing = storedById.get(module.id);
    return moduleState(
      module.id,
      existing?.enabled ?? false,
      existing?.settings ?? JSON.stringify(module.defaultSettings),
    );
  });
  return context.json({ modules });
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
  const settings = existing === null || enabled ? defaultSettingsJson : existing.settings;
  const changed = existing === null
    ? await createChannelModuleWithAudit(
      context.env.DB,
      actor,
      { channelId, moduleId, enabled, settings },
      action,
      now,
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
    );
  if (!changed) return context.text("Modul wurde inzwischen geändert.", 409);
  try {
    await maintainEventSubSubscriptions(context.env, now, fetch, channelId);
  } catch {
    // Der Abgleich schreibt den Fehlerzustand selbst; die Moduländerung bleibt erfolgreich.
  }
  return context.json({ module: moduleState(moduleId, enabled, settings) });
});

for (const module of MODULES) {
  if (module.routes !== undefined) {
    moduleRouter.route(`/api/channels/:channelId/modules/${module.id}`, module.routes);
  }
}
