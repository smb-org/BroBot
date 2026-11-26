import { Hono, type Context } from "hono";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import type { DiscordRoleMappings } from "./contracts";
import {
  discordSelectableRoles,
  readDiscordGuildState,
  type DiscordEnvironment,
} from "./adapters/discord";
import {
  disconnectDiscordServer,
  getDiscordRoleMappings,
  getDiscordServerConnection,
  saveDiscordRoleMappings,
} from "./repository";

type RouteContext = Context<ModuleRouteEnvironment>;
type RequestBody = Record<string, unknown>;

const channel = (context: RouteContext): string => context.req.param("channelId") ?? "";
const isManager = (context: RouteContext): boolean => canManage(context.get("channelRole"));
const managerDenied = (context: RouteContext): Response => context.json({ error: "discord_manager_required" }, 403);
const configured = (environment: DiscordEnvironment): boolean =>
  typeof environment.DISCORD_CLIENT_ID === "string" && environment.DISCORD_CLIENT_ID.length > 0 &&
  typeof environment.DISCORD_CLIENT_SECRET === "string" && environment.DISCORD_CLIENT_SECRET.length > 0 &&
  typeof environment.DISCORD_BOT_TOKEN === "string" && environment.DISCORD_BOT_TOKEN.length > 0;

const bodyFrom = async (request: Request): Promise<RequestBody | null> => {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RequestBody : null;
  } catch {
    return null;
  }
};

const parseMappings = (body: RequestBody | null): DiscordRoleMappings | null => {
  if (body === null || Object.keys(body).some((key) => key !== "vip" && key !== "moderator")) return null;
  const vip = body.vip;
  const moderator = body.moderator;
  const validRole = (value: unknown): value is string | null =>
    value === null || (typeof value === "string" && /^[0-9]{1,20}$/u.test(value));
  return validRole(vip) && validRole(moderator) ? { vip, moderator } : null;
};

const withNoStore = (context: RouteContext): void => { context.header("Cache-Control", "no-store"); };

const discordServerRoutes = new Hono<ModuleRouteEnvironment>();

discordServerRoutes.get("/server", async (context) => {
  withNoStore(context);
  if (!configured(context.env)) {
    return context.json({ configured: false, connection: null, mappings: { vip: null, moderator: null }, state: "not_available", guildName: null, roles: [], rolesAvailable: false, botHighestRolePosition: null });
  }
  const channelId = channel(context);
  const [connection, mappings] = await Promise.all([
    getDiscordServerConnection(context.env.DB, channelId),
    getDiscordRoleMappings(context.env.DB, channelId),
  ]);
  if (connection === null) {
    return context.json({ configured: true, connection: null, mappings, state: "not_connected", guildName: null, roles: [], rolesAvailable: false, botHighestRolePosition: null });
  }
  const result = await readDiscordGuildState(context.env, connection.guildId, mappings);
  return context.json({
    configured: true,
    connection,
    mappings,
    state: result.state,
    guildName: result.guild?.name ?? null,
    roles: result.guild === null ? [] : discordSelectableRoles(result.roles, connection.guildId),
    rolesAvailable: result.guild !== null,
    botHighestRolePosition: result.botHighestRolePosition,
  });
});

discordServerRoutes.post("/server/oauth/start", async (context) => {
  withNoStore(context);
  if (!isManager(context)) return managerDenied(context);
  if (!configured(context.env)) return context.json({ error: "discord_not_available" }, 503);
  const begin = context.get("beginDiscordServerOAuth");
  if (begin === undefined) return context.json({ error: "discord_oauth_unavailable" }, 503);
  try {
    const transaction = await begin(channel(context), context.get("session").userId);
    context.header("Set-Cookie", transaction.stateCookie);
    return context.json({ authorizationUrl: transaction.authorizationUrl });
  } catch {
    return context.json({ error: "discord_oauth_unavailable" }, 503);
  }
});

discordServerRoutes.post("/server/mappings", async (context) => {
  withNoStore(context);
  if (!isManager(context)) return managerDenied(context);
  const submitted = parseMappings(await bodyFrom(context.req.raw));
  if (submitted === null) return context.json({ error: "discord_mapping_invalid" }, 400);
  const channelId = channel(context);
  const connection = await getDiscordServerConnection(context.env.DB, channelId);
  if (connection === null) return context.json({ error: "discord_server_not_connected" }, 409);
  const previous = await getDiscordRoleMappings(context.env.DB, channelId);
  const needsRoleList = (Object.keys(submitted) as Array<keyof DiscordRoleMappings>).some((rankType) =>
    submitted[rankType] !== null && submitted[rankType] !== previous[rankType]);
  if (needsRoleList) {
    if (!configured(context.env)) return context.json({ error: "discord_not_available" }, 503);
    const current = await readDiscordGuildState(context.env, connection.guildId, previous);
    if (current.guild === null) return context.json({ error: "discord_roles_unavailable" }, 503);
    const selectable = new Set(discordSelectableRoles(current.roles, connection.guildId).map(({ id }) => id));
    for (const rankType of ["vip", "moderator"] as const) {
      const roleId = submitted[rankType];
      if (roleId !== null && roleId !== previous[rankType] && !selectable.has(roleId)) {
        return context.json({ error: "discord_mapping_role_invalid" }, 400);
      }
    }
  }
  await saveDiscordRoleMappings(context.env.DB, channelId, submitted, new Date().toISOString());
  return context.json({ mappings: submitted });
});

discordServerRoutes.post("/server/disconnect", async (context) => {
  withNoStore(context);
  if (!isManager(context)) return managerDenied(context);
  const requestOrigin = context.req.header("Origin");
  // The panel guard already verifies the CSRF token for every mutation; the Origin check is the extra layer here.
  if (requestOrigin === undefined || requestOrigin !== new URL(context.env.PUBLIC_ORIGIN).origin) {
    return context.json({ error: "discord_origin_invalid" }, 403);
  }
  await disconnectDiscordServer(context.env.DB, channel(context));
  return context.body(null, 204);
});

export { discordServerRoutes };
