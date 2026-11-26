import type { DiscordRoleMappings, DiscordServerConnection, DiscordServerConnectionState, DiscordServerRole } from "../contracts";

const route = (channelId: string, part: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/discord/${part}`;

export const request = async <Value,>(channelId: string, part: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Value> => {
  const headers = new Headers(body === undefined ? undefined : { "Content-Type": "application/json" });
  if (method !== "GET" && method !== "HEAD") {
    const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin" });
    if (!csrfResponse.ok) throw new Error("csrf_unavailable");
    const csrf = await csrfResponse.json<{ token?: unknown }>();
    if (typeof csrf.token !== "string") throw new Error("csrf_unavailable");
    headers.set("X-CSRF-Token", csrf.token);
  }
  const response = await fetch(route(channelId, part), {
    method,
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    let error = "request_failed";
    try { error = (await response.json<{ error?: string }>()).error ?? error; } catch { /* Keep the fallback. */ }
    throw new Error(error);
  }
  if (response.status === 204) return undefined as Value;
  return await response.json<Value>();
};

export interface DiscordServerRead {
  configured: boolean;
  connection: DiscordServerConnection | null;
  mappings: DiscordRoleMappings;
  state: DiscordServerConnectionState;
  guildName: string | null;
  roles: DiscordServerRole[];
  rolesAvailable: boolean;
  botHighestRolePosition: number | null;
  teardown: boolean;
  disconnecting: boolean;
  teardownRemaining: number;
  locked: boolean;
  globalTokenLocked: boolean;
  chatHintEnabled: boolean;
  hintSettingsRevision: number;
}

export const readDiscordServer = (channelId: string, signal?: AbortSignal): Promise<DiscordServerRead> =>
  request<DiscordServerRead>(channelId, "server", "GET", undefined, signal);

export const saveDiscordMappings = (channelId: string, guildId: string, mappings: DiscordRoleMappings): Promise<{ mappings: DiscordRoleMappings }> =>
  request<{ mappings: DiscordRoleMappings }>(channelId, "server/mappings", "POST", { guildId, ...mappings });

export interface DiscordMappingPreview {
  gain: { count: number; roleName: string };
  lose: { count: number; roleName: string }[];
}

export const previewDiscordMappings = (channelId: string, guildId: string, mappings: DiscordRoleMappings): Promise<DiscordMappingPreview> =>
  request<DiscordMappingPreview>(channelId, "server/mappings/preview", "POST", { guildId, ...mappings });

export const saveDiscordChatHint = (channelId: string, chatHintEnabled: boolean, revision: number): Promise<{
  settings: { chatHintEnabled: boolean };
  revision: number;
}> => request(channelId, "settings", "PATCH", { settings: { chatHintEnabled }, revision });

export const readDiscordChatHint = (channelId: string, signal?: AbortSignal): Promise<{
  settings: { chatHintEnabled: boolean };
  revision: number;
}> => request(channelId, "settings", "GET", undefined, signal);
