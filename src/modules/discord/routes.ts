import { Hono, type Context } from "hono";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import type { DiscordRoleMappings, DiscordServerRole } from "./contracts";
import {
  discordSelectableRoles,
  readDiscordGuildState,
  DiscordRequestError,
  type DiscordEnvironment,
} from "./adapters/discord";
import {
  claimDiscordServerDisconnect,
  disconnectDiscordServer,
  getDiscordRoleMappings,
  getDiscordServerConnection,
  saveDiscordRoleMappings,
} from "./repository";
import { discordSettingsSchema } from "./contracts";

const loadChannelModules = () => import("../../worker/db/channel-modules");
const loadTokenLock = () => import("../../worker/discord/token-lock");
const loadEventLog = () => import("../../worker/event-log");

interface DiscordChannelObjectRpc {
  discordChannelState: () => Promise<{
    teardown: boolean;
    disconnecting: boolean;
    teardownRemaining: number;
    ledgerCount: number;
    locked: boolean;
    serverLocked: boolean;
    mappingLocked: boolean;
    globalTokenLocked: boolean;
  }>;
  cacheDiscordRoleNames: (guildId: string, connectedAt: string, roles: readonly DiscordServerRole[]) => Promise<void>;
  readDiscordCachedRoles: () => Promise<DiscordServerRole[]>;
  discordMappingsChanged: (
    previous: DiscordRoleMappings,
    next: DiscordRoleMappings,
    roles: readonly DiscordServerRole[] | null,
  ) => Promise<void>;
  beginDiscordReconcileMutation: (blockDuringCleanup?: boolean) => Promise<string | null>;
  endDiscordReconcileMutation: (token: string) => Promise<void>;
  beginDiscordDisconnect: (expectedGuildId: string, expectedConnectedAt: string) => Promise<{ deferred: boolean; remaining: number; blocked?: boolean; changed?: boolean }>;
  clearDiscordGuildStateAfterDisconnect: (guildId: string, expectedConnectedAt: string) => Promise<boolean>;
  cancelImmediateDiscordDisconnect: (guildId: string, expectedConnectedAt: string) => Promise<void>;
  lockDiscordServer: (guildId: string, reason: string, expectedConnectedAt: string) => Promise<boolean>;
  previewDiscordMappings: (mappings: DiscordRoleMappings) => Promise<{
    gain: { count: number; roleName: string };
    lose: Array<{ count: number; roleName: string }>;
  }>;
}

const discordObject = (environment: ModuleRouteEnvironment["Bindings"], channelId: string): DiscordChannelObjectRpc =>
  environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));

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

const parseMappings = (body: RequestBody | null): { guildId: string; mappings: DiscordRoleMappings } | null => {
  if (body === null || Object.keys(body).some((key) => key !== "guildId" && key !== "vip" && key !== "moderator")) return null;
  const guildId = body.guildId;
  const vip = body.vip;
  const moderator = body.moderator;
  const validRole = (value: unknown): value is string | null =>
    value === null || (typeof value === "string" && /^[0-9]{1,20}$/u.test(value));
  return typeof guildId === "string" && /^[0-9]{1,20}$/u.test(guildId) && validRole(vip) && validRole(moderator)
    ? { guildId, mappings: { vip, moderator } }
    : null;
};

const withNoStore = (context: RouteContext): void => { context.header("Cache-Control", "no-store"); };

const discordServerRoutes = new Hono<ModuleRouteEnvironment>();

discordServerRoutes.get("/server", async (context) => {
  withNoStore(context);
  if (!configured(context.env)) {
    return context.json({ configured: false, connection: null, mappings: { vip: null, moderator: null }, state: "not_available", guildName: null, roles: [], rolesAvailable: false, botHighestRolePosition: null, teardown: false, disconnecting: false, teardownRemaining: 0, locked: false, globalTokenLocked: false, chatHintEnabled: true, hintSettingsRevision: 0 });
  }
  const channelId = channel(context);
  const [connection, mappings] = await Promise.all([
    getDiscordServerConnection(context.env.DB, channelId),
    getDiscordRoleMappings(context.env.DB, channelId),
  ]);
  if (connection === null) {
    const stored = await (await loadChannelModules()).getChannelModuleForChannel(context.env.DB, channelId, "discord");
    let chatHintEnabled = true;
    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored.settings);
        const settings = discordSettingsSchema.safeParse(parsed);
        if (settings.success) chatHintEnabled = settings.data.chatHintEnabled;
      } catch { /* Keep the module default for a malformed row. */ }
    }
    return context.json({ configured: true, connection: null, mappings, state: "not_connected", guildName: null, roles: [], rolesAvailable: false, botHighestRolePosition: null, teardown: false, disconnecting: false, teardownRemaining: 0, locked: false, globalTokenLocked: false, chatHintEnabled, hintSettingsRevision: stored?.settingsRevision ?? 0 });
  }
  const object = discordObject(context.env, channelId);
  const channelModules = await loadChannelModules();
  const [locks, stored] = await Promise.all([
    object.discordChannelState(),
    channelModules.getChannelModuleForChannel(context.env.DB, channelId, "discord"),
  ]);
  let chatHintEnabled = true;
  if (stored !== null) {
    try {
      const parsed: unknown = JSON.parse(stored.settings);
      const settings = discordSettingsSchema.safeParse(parsed);
      if (settings.success) chatHintEnabled = settings.data.chatHintEnabled;
    } catch { /* Keep the module default for a malformed row. */ }
  }
  if (locks.serverLocked || locks.mappingLocked || locks.globalTokenLocked || locks.teardown || locks.disconnecting) {
    const cachedRoles = await object.readDiscordCachedRoles();
    return context.json({
      configured: true, connection, mappings, state: "could_not_check", guildName: null,
      roles: discordSelectableRoles(cachedRoles, connection.guildId), rolesAvailable: cachedRoles.length > 0,
      botHighestRolePosition: null, ...locks, chatHintEnabled, hintSettingsRevision: stored?.settingsRevision ?? 0,
    });
  }
  let result;
  try {
    result = await readDiscordGuildState(context.env, connection.guildId, mappings);
  } catch (error) {
    if (error instanceof DiscordRequestError && error.status === 401) {
      const now = new Date().toISOString();
      const wasLocked = await (await loadTokenLock()).setDiscordBotTokenLock(context.env.DB, now);
      if (wasLocked) await (await loadEventLog()).writeModuleDiagnostics(context.env.DB, channelId, "discord", `discord:token_lock:set:${now}`, null, [{ code: "discord.token_lock_set" }], now, true);
    }
    return context.json({
      configured: true, connection, mappings, state: "could_not_check", guildName: null, roles: [], rolesAvailable: false,
      botHighestRolePosition: null, ...locks, chatHintEnabled, hintSettingsRevision: stored?.settingsRevision ?? 0,
    });
  }
  if (result.state === "bot_removed") {
    const locked = await object.lockDiscordServer(connection.guildId, "bot_removed", connection.connectedAt);
    if (locked) {
      locks.serverLocked = true;
      locks.locked = true;
    }
  }
  const latestConnection = await getDiscordServerConnection(context.env.DB, channelId);
  if (result.guild !== null && latestConnection?.guildId === connection.guildId &&
      latestConnection.connectedAt === connection.connectedAt) {
    await object.cacheDiscordRoleNames(connection.guildId, connection.connectedAt, result.roles);
  }
  return context.json({
    configured: true,
    connection,
    mappings,
    state: result.state,
    guildName: result.guild?.name ?? null,
    roles: result.guild === null ? [] : discordSelectableRoles(result.roles, connection.guildId),
    rolesAvailable: result.guild !== null,
    botHighestRolePosition: result.botHighestRolePosition,
    ...locks,
    chatHintEnabled,
    hintSettingsRevision: stored?.settingsRevision ?? 0,
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
  const parsed = parseMappings(await bodyFrom(context.req.raw));
  if (parsed === null) return context.json({ error: "discord_mapping_invalid" }, 400);
  const { guildId, mappings: submitted } = parsed;
  const channelId = channel(context);
  const connection = await getDiscordServerConnection(context.env.DB, channelId);
  if (connection === null) return context.json({ error: "discord_server_not_connected" }, 409);
  if (connection.guildId !== guildId) return context.json({ error: "discord_server_changed" }, 409);
  const object = discordObject(context.env, channelId);
  const currentState = await object.discordChannelState();
  if (currentState.teardown || currentState.disconnecting) return context.json({ error: "discord_cleanup_in_progress" }, 409);
  const updatedAt = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("session"), updatedAt);
  const mutationToken = await object.beginDiscordReconcileMutation();
  if (mutationToken === null) return context.json({ error: "discord_cleanup_in_progress" }, 409);
  let saved: Awaited<ReturnType<typeof saveDiscordRoleMappings>>;
  let effect: Awaited<ReturnType<typeof object.previewDiscordMappings>> | null = null;
  try {
    const authoritativeConnection = await getDiscordServerConnection(context.env.DB, channelId);
    if (authoritativeConnection === null || authoritativeConnection.guildId !== guildId ||
        authoritativeConnection.connectedAt !== connection.connectedAt) {
      saved = "connection_changed";
    } else {
      const authoritativePrevious = await getDiscordRoleMappings(context.env.DB, channelId);
      const needsRoleList = (["vip", "moderator"] as const).some((rankType) =>
        submitted[rankType] !== null && submitted[rankType] !== authoritativePrevious[rankType]);
      let currentRoles: DiscordServerRole[] | null = null;
      if (needsRoleList) {
        const locks = await object.discordChannelState();
        if (locks.serverLocked || locks.mappingLocked || locks.globalTokenLocked) {
          currentRoles = await object.readDiscordCachedRoles();
        } else {
          if (!configured(context.env)) return context.json({ error: "discord_not_available" }, 503);
          let current;
          try {
            current = await readDiscordGuildState(context.env, guildId, authoritativePrevious);
          } catch (error) {
            if (error instanceof DiscordRequestError && error.status === 401) {
              const now = new Date().toISOString();
              const wasLocked = await (await loadTokenLock()).setDiscordBotTokenLock(context.env.DB, now);
              if (wasLocked) await (await loadEventLog()).writeModuleDiagnostics(context.env.DB, channelId, "discord", `discord:token_lock:set:${now}`, null, [{ code: "discord.token_lock_set" }], now, true);
            }
            return context.json({ error: "discord_roles_unavailable" }, 503);
          }
          if (current.state === "bot_removed") await object.lockDiscordServer(guildId, "bot_removed", connection.connectedAt);
          if (current.guild === null) return context.json({ error: "discord_roles_unavailable" }, 503);
          currentRoles = current.roles;
        }
        if (currentRoles.length === 0) return context.json({ error: "discord_roles_unavailable" }, 503);
        const selectable = new Set(discordSelectableRoles(currentRoles, guildId).map(({ id }) => id));
        for (const rankType of ["vip", "moderator"] as const) {
          const roleId = submitted[rankType];
          if (roleId !== null && roleId !== authoritativePrevious[rankType] && !selectable.has(roleId)) {
            return context.json({ error: "discord_mapping_role_invalid" }, 400);
          }
        }
      }
      const mappingChanged = authoritativePrevious.vip !== submitted.vip || authoritativePrevious.moderator !== submitted.moderator;
      effect = mappingChanged ? await object.previewDiscordMappings(submitted) : null;
      saved = await saveDiscordRoleMappings(
        context.env.DB,
        channelId,
        guildId,
        connection.connectedAt,
        submitted,
        updatedAt,
        authorization,
      );
      if (saved === "saved") await object.discordMappingsChanged(authoritativePrevious, submitted, currentRoles);
    }
  } finally {
    await object.endDiscordReconcileMutation(mutationToken);
  }
  if (saved === "connection_changed") return context.json({ error: "discord_server_changed" }, 409);
  if (saved === "not_authorized") return managerDenied(context);
  if (effect !== null) await (await loadEventLog()).writeModuleDiagnostics(
    context.env.DB,
    channelId,
    "discord",
    `discord:mapping_change:${updatedAt}`,
    context.get("session").userId,
    [{
      code: "discord.mapping_changed",
      detail: {
        granted: effect.gain.count,
        removed: effect.lose.reduce((total, entry) => total + entry.count, 0),
        failed: 0,
        skipped: 0,
      },
    }],
    updatedAt,
    true,
  );
  return context.json({ mappings: submitted });
});

discordServerRoutes.post("/server/mappings/preview", async (context) => {
  withNoStore(context);
  if (!isManager(context)) return managerDenied(context);
  const parsed = parseMappings(await bodyFrom(context.req.raw));
  if (parsed === null) return context.json({ error: "discord_mapping_invalid" }, 400);
  const channelId = channel(context);
  const connection = await getDiscordServerConnection(context.env.DB, channelId);
  if (connection === null) return context.json({ error: "discord_server_not_connected" }, 409);
  if (connection.guildId !== parsed.guildId) return context.json({ error: "discord_server_changed" }, 409);
  const object = discordObject(context.env, channelId);
  return context.json(await object.previewDiscordMappings(parsed.mappings));
});

discordServerRoutes.post("/server/disconnect", async (context) => {
  withNoStore(context);
  const requestOrigin = context.req.header("Origin");
  // The panel guard already verifies the CSRF token for every mutation; the Origin check is the extra layer here.
  if (requestOrigin === undefined || requestOrigin !== new URL(context.env.PUBLIC_ORIGIN).origin) {
    return context.json({ error: "discord_origin_invalid" }, 403);
  }
  const body = await bodyFrom(context.req.raw);
  if (body === null || Object.keys(body).some((key) => key !== "guildId" && key !== "connectedAt") ||
      typeof body.guildId !== "string" || !/^[0-9]{1,20}$/u.test(body.guildId) ||
      typeof body.connectedAt !== "string" || body.connectedAt.length === 0) {
    return context.json({ error: "discord_disconnect_invalid" }, 400);
  }
  const existingConnection = await getDiscordServerConnection(context.env.DB, channel(context));
  if (existingConnection === null) return context.json({ error: "discord_server_not_connected" }, 409);
  if (existingConnection.guildId !== body.guildId || existingConnection.connectedAt !== body.connectedAt) {
    return context.json({ error: "discord_server_changed" }, 409);
  }
  const disconnectedAt = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channel(context), context.get("actor"), disconnectedAt);
  const claimed = await claimDiscordServerDisconnect(
    context.env.DB,
    channel(context),
    body.guildId,
    body.connectedAt,
    authorization,
  );
  if (claimed === "not_authorized") return managerDenied(context);
  if (claimed === "connection_changed") return context.json({ error: "discord_server_changed" }, 409);
  const object = discordObject(context.env, channel(context));
  const cleanup = await object.beginDiscordDisconnect(body.guildId, body.connectedAt);
  if (cleanup.changed) return context.json({ error: "discord_server_changed" }, 409);
  if (cleanup.blocked) return context.json({ error: "discord_cleanup_in_progress" }, 409);
  if (cleanup.deferred) return context.json({ disconnecting: true, remaining: cleanup.remaining }, 202);
  const disconnected = await disconnectDiscordServer(context.env.DB, channel(context), existingConnection.guildId, existingConnection.connectedAt, authorization);
  if (!disconnected) {
    const stillAuthorized = await context.env.DB.prepare(`SELECT 1 AS allowed WHERE 1 = 1 ${authorization.sql}`)
      .bind(...authorization.values).first<{ allowed: number }>();
    if (stillAuthorized === null) {
      await object.cancelImmediateDiscordDisconnect(existingConnection.guildId, existingConnection.connectedAt);
      return managerDenied(context);
    }
    return context.json({ error: "discord_server_changed" }, 409);
  }
  await object.clearDiscordGuildStateAfterDisconnect(existingConnection.guildId, existingConnection.connectedAt);
  return context.body(null, 204);
});

export { discordServerRoutes };
