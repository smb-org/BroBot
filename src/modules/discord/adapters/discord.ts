import { readBoundedJsonResponse } from "../../contract";
import type { DiscordServerConnectionState, DiscordServerRole } from "../contracts";

declare global {
  interface Env {
    DISCORD_API_BASE?: string;
  }
}

export type DiscordEnvironment = Partial<Pick<Env,
  "APP_ENV" | "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET" | "DISCORD_API_BASE" | "DISCORD_BOT_TOKEN"
>>;

interface DiscordToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
}

interface DiscordConnection {
  id: string;
  name: string;
  type: string;
  verified: boolean;
  revoked?: boolean;
}

class DiscordRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly discordCode: number | null,
    public readonly path: string,
  ) {
    super(message);
    this.name = "DiscordRequestError";
  }
}

const configuredBase = (environment: DiscordEnvironment): { api: string; origin: string } => {
  const override = environment.APP_ENV === "local" ? environment.DISCORD_API_BASE : undefined;
  if (override === undefined || override.length === 0) {
    return { api: "https://discord.com/api/v10", origin: "https://discord.com" };
  }
  const url = new URL(override);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new Error("Discord endpoint override is invalid.");
  }
  return { api: url.toString().replace(/\/+$/u, ""), origin: url.origin };
};

const DISCORD_REQUEST_TIMEOUT_MS = 10_000;
const DISCORD_SCOPE = "identify connections";

export const discordAuthorizationUrl = (
  environment: DiscordEnvironment,
  redirectUri: string,
  state: string,
): string => {
  if (environment.DISCORD_CLIENT_ID === undefined || environment.DISCORD_CLIENT_ID.length === 0) {
    throw new Error("Discord OAuth is not configured.");
  }
  const url = new URL("/oauth2/authorize", configuredBase(environment).origin);
  url.searchParams.set("client_id", environment.DISCORD_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", DISCORD_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
};

export const exchangeDiscordCode = async (
  environment: DiscordEnvironment,
  redirectUri: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscordToken> => {
  const clientId = environment.DISCORD_CLIENT_ID;
  const clientSecret = environment.DISCORD_CLIENT_SECRET;
  if (clientId === undefined || clientId.length === 0 || clientSecret === undefined || clientSecret.length === 0) {
    throw new Error("Discord OAuth is not configured.");
  }
  const { origin } = configuredBase(environment);
  const response = await fetcher(new URL("/api/oauth2/token", origin), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new DiscordRequestError("Discord token exchange failed.", response.status, null, "oauth2/token");
  const token = await readBoundedJsonResponse(response);
  if (typeof token !== "object" || token === null || Array.isArray(token)) throw new Error("Discord token response was invalid.");
  const record = token as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token.length === 0 || record.token_type !== "Bearer" ||
      typeof record.expires_in !== "number" || typeof record.scope !== "string") {
    throw new Error("Discord token response was invalid.");
  }
  return {
    access_token: record.access_token,
    token_type: "Bearer",
    expires_in: record.expires_in,
    scope: record.scope,
    ...(typeof record.refresh_token === "string" ? { refresh_token: record.refresh_token } : {}),
  };
};

export const discordServerAuthorizationUrl = (
  environment: DiscordEnvironment,
  redirectUri: string,
  state: string,
): string => {
  if (environment.DISCORD_CLIENT_ID === undefined || environment.DISCORD_CLIENT_ID.length === 0) {
    throw new Error("Discord OAuth is not configured.");
  }
  const url = new URL("/oauth2/authorize", configuredBase(environment).origin);
  url.searchParams.set("client_id", environment.DISCORD_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "bot");
  url.searchParams.set("permissions", "268435456");
  url.searchParams.set("state", state);
  return url.toString();
};

export const exchangeDiscordServerCode = async (
  environment: DiscordEnvironment,
  redirectUri: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<{ guildId: string }> => {
  const clientId = environment.DISCORD_CLIENT_ID;
  const clientSecret = environment.DISCORD_CLIENT_SECRET;
  if (clientId === undefined || clientId.length === 0 || clientSecret === undefined || clientSecret.length === 0) {
    throw new Error("Discord OAuth is not configured.");
  }
  const { origin } = configuredBase(environment);
  const response = await fetcher(new URL("/api/oauth2/token", origin), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new DiscordRequestError("Discord server token exchange failed.", response.status, null, "oauth2/token");
  const token = await readBoundedJsonResponse(response);
  if (typeof token !== "object" || token === null || Array.isArray(token)) throw new Error("Discord server token response was invalid.");
  const record = token as Record<string, unknown>;
  const guild = record.guild;
  const guildId = typeof guild === "object" && guild !== null && !Array.isArray(guild) ? (guild as Record<string, unknown>).id : undefined;
  if (typeof guildId !== "string" || guildId === "" || typeof record.access_token !== "string" || record.access_token.length === 0 || record.token_type !== "Bearer" ||
      typeof record.expires_in !== "number" || typeof record.scope !== "string") {
    throw new Error("Discord server token response was invalid.");
  }
  return { guildId };
};

const discordApiGet = async <Value>(
  environment: DiscordEnvironment,
  authorization: string,
  path: string,
  fetcher: typeof fetch,
): Promise<Value> => {
  const { api } = configuredBase(environment);
  const response = await fetcher(new URL(path.replace(/^\/+/, ""), `${api}/`), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    let discordCode: number | null = null;
    try {
      const error = await readBoundedJsonResponse(response);
      const code = typeof error === "object" && error !== null && !Array.isArray(error) ? (error as Record<string, unknown>).code : undefined;
      if (typeof code === "number") discordCode = code;
    } catch {
      // The HTTP status still gives the caller a neutral unavailable result.
    }
    throw new DiscordRequestError("Discord API request failed.", response.status, discordCode, path);
  }
  return await readBoundedJsonResponse<Value>(response);
};

export interface DiscordGuildStateRead {
  state: Exclude<DiscordServerConnectionState, "not_connected" | "not_available">;
  guild: { id: string; name: string } | null;
  roles: DiscordServerRole[];
  botHighestRolePosition: number | null;
}

const parseDiscordRoles = (value: unknown): DiscordServerRole[] | null => {
  if (!Array.isArray(value)) return null;
  const roles = value.flatMap((entry): DiscordServerRole[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const role = entry as Record<string, unknown>;
    return typeof role.id === "string" && typeof role.name === "string" && Number.isSafeInteger(role.position) &&
      typeof role.permissions === "string" && /^\d+$/u.test(role.permissions) && typeof role.managed === "boolean"
      ? [{ id: role.id, name: role.name, position: role.position as number, permissions: role.permissions, managed: role.managed }]
      : [];
  });
  return roles.length === value.length ? roles : null;
};

export const discordSelectableRoles = (roles: readonly DiscordServerRole[], guildId: string): DiscordServerRole[] =>
  roles.filter((role) => role.id !== guildId && !role.managed);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readDiscordGuildState = async (
  environment: DiscordEnvironment,
  guildId: string,
  mappings: { vip: string | null; moderator: string | null },
  fetcher: typeof fetch = fetch,
): Promise<DiscordGuildStateRead> => {
  const fallback: DiscordGuildStateRead = { state: "could_not_check", guild: null, roles: [], botHighestRolePosition: null };
  const botToken = environment.DISCORD_BOT_TOKEN;
  if (botToken === undefined || botToken.length === 0) return fallback;
  try {
    const me = await discordApiGet<unknown>(environment, `Bot ${botToken}`, "users/@me", fetcher);
    if (!isRecord(me) || typeof me.id !== "string" || me.id.length === 0) return fallback;
    const [guildValue, rolesValue, memberValue] = await Promise.all([
      discordApiGet<unknown>(environment, `Bot ${botToken}`, `guilds/${encodeURIComponent(guildId)}`, fetcher),
      discordApiGet<unknown>(environment, `Bot ${botToken}`, `guilds/${encodeURIComponent(guildId)}/roles`, fetcher),
      discordApiGet<unknown>(environment, `Bot ${botToken}`, `guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(me.id)}`, fetcher),
    ]);
    if (!isRecord(guildValue) || guildValue.id !== guildId || typeof guildValue.name !== "string" ||
        !isRecord(memberValue) || !Array.isArray(memberValue.roles) || !memberValue.roles.every((id) => typeof id === "string")) return fallback;
    const roles = parseDiscordRoles(rolesValue);
    if (roles === null) return fallback;
    const botRoleIds = memberValue.roles;
    const botRoles = roles.filter((role) => botRoleIds.includes(role.id));
    const permissions = botRoles.reduce((total, role) => {
      try { return total | BigInt(role.permissions); } catch { return total; }
    }, 0n);
    const admin = (permissions & (1n << 3n)) !== 0n;
    const canManageRoles = (permissions & (1n << 28n)) !== 0n;
    const botHighestRolePosition = botRoles.reduce((highest, role) => Math.max(highest, role.position), -1);
    const mappedRoleIds = [mappings.vip, mappings.moderator].filter((id): id is string => id !== null);
    const mappedRoleTooLow = mappedRoleIds.some((id) => {
      const mappedRole = roles.find((role) => role.id === id);
      return mappedRole !== undefined && mappedRole.position >= botHighestRolePosition;
    });
    return {
      state: !admin && !canManageRoles ? "permissions_missing" : mappedRoleTooLow ? "role_too_low" : "connected",
      guild: { id: guildId, name: guildValue.name },
      roles,
      botHighestRolePosition,
    };
  } catch (error) {
    if (error instanceof DiscordRequestError && error.path !== "users/@me" &&
        (error.discordCode === 10004 || error.discordCode === 50001)) {
      return { ...fallback, state: "bot_removed" };
    }
    return fallback;
  }
};

export const fetchDiscordUser = async (
  environment: DiscordEnvironment,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscordUser> => {
  const value = await discordApiGet<unknown>(environment, `Bearer ${accessToken}`, "users/@me", fetcher);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Discord user response was invalid.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || typeof record.username !== "string" || record.username.length === 0) {
    throw new Error("Discord user response was invalid.");
  }
  return { id: record.id, username: record.username };
};

export const fetchDiscordConnections = async (
  environment: DiscordEnvironment,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscordConnection[]> => {
  const value = await discordApiGet<unknown>(environment, `Bearer ${accessToken}`, "users/@me/connections", fetcher);
  if (!Array.isArray(value)) throw new Error("Discord connections response was invalid.");
  return value.flatMap((entry): DiscordConnection[] => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const connection = entry as Record<string, unknown>;
    return typeof connection.id === "string" && typeof connection.name === "string" &&
      typeof connection.type === "string" && typeof connection.verified === "boolean"
      ? [{
        id: connection.id,
        name: connection.name,
        type: connection.type,
        verified: connection.verified,
        ...(typeof connection.revoked === "boolean" ? { revoked: connection.revoked } : {}),
      }]
      : [];
  });
};

export const verifiedTwitchConnection = (
  connections: readonly DiscordConnection[],
): { twitchUserId: string; twitchLogin: string } | null => {
  const connection = connections.find((entry) =>
    entry.type === "twitch" && entry.verified && entry.revoked !== true && entry.id.length > 0 && entry.name.length > 0);
  return connection === undefined ? null : { twitchUserId: connection.id, twitchLogin: connection.name };
};
