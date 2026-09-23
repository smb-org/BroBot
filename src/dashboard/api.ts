import type {
  PanelAuditFilters,
  PanelAuditResponse,
  PanelPlatformMembersResponse,
  PanelPlatformAuditResponse,
  PanelPlatformOverviewResponse,
  PanelChannelOverview,
  PanelChannelControls,
  PanelChannelsResponse,
  PanelEventsResponse,
  PanelEventFilters,
  PanelMember,
  PanelMembersResponse,
  PanelModeratorStatus,
  PanelModuleState,
  PanelTemplateWarningResponse,
  PanelModulesResponse,
  PanelSystemResponse,
  PanelTwitchUser,
} from "../panel-contract";
import type { ChannelControlDuration, ChannelRole } from "../contracts/values";

import { PanelApiError } from "../contracts/panel-error";

export { PanelApiError };


const hasParentPathSegment = (input: string): boolean => {
  const pathEnd = input.search(/[?#]/);
  const path = pathEnd === -1 ? input : input.slice(0, pathEnd);
  return path.split("/").some((segment) => {
    try {
      return decodeURIComponent(segment) === "..";
    } catch {
      return false;
    }
  });
};

const isAllowedRequestPath = (pathname: string): boolean =>
  pathname === "/api/channels" ||
  pathname.startsWith("/api/channels/") ||
  pathname === "/api/platform" ||
  pathname.startsWith("/api/platform/") ||
  pathname === "/api/csrf" ||
  pathname === "/auth/logout";

const resolveRequestUrl = (input: string): URL => {
  let url: URL;
  try {
    url = new URL(input, window.location.origin);
  } catch {
    throw new PanelApiError(400, "panel_request_not_allowed");
  }
  if (url.origin !== window.location.origin || hasParentPathSegment(input) || !isAllowedRequestPath(url.pathname)) {
    throw new PanelApiError(400, "panel_request_not_allowed");
  }
  return url;
};

export const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const url = resolveRequestUrl(input);
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const responseText = await response.text();
    let code: string | null = null;
    let details: unknown = null;
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = parsed;
        const error = (parsed as Record<string, unknown>).error;
        if (typeof error === "string" && error.length > 0) code = error;
      }
    } catch {
      // Error responses may also be plain text (old worker, proxy, network failure).
    }
    throw new PanelApiError(response.status, code, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
};

const requestOptions = (signal: AbortSignal | undefined): RequestInit | undefined =>
  signal === undefined ? undefined : { signal };

const channelPath = (channelId: string, suffix: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;

const memberPath = (channelId: string, userId?: string): string =>
  `${channelPath(channelId, "members")}${userId === undefined ? "" : `/${encodeURIComponent(userId)}`}`;

const modulePath = (channelId: string, moduleId?: string): string =>
  `${channelPath(channelId, "modules")}${moduleId === undefined ? "" : `/${encodeURIComponent(moduleId)}`}`;

export const fetchChannels = (signal?: AbortSignal): Promise<PanelChannelsResponse> =>
  requestJson<PanelChannelsResponse>("/api/channels", requestOptions(signal));

export const getPlatformOverview = (): Promise<PanelPlatformOverviewResponse> =>
  requestJson<PanelPlatformOverviewResponse>("/api/platform");

export const searchPlatformUser = (login: string): Promise<{ user: PanelTwitchUser }> =>
  requestJson<{ user: PanelTwitchUser }>(`/api/platform/users?${new URLSearchParams({ login }).toString()}`);

export const releasePlatformChannel = (
  login: string,
  fullConsent: boolean,
): Promise<{ channel: PanelPlatformOverviewResponse["channels"][number] }> => requestMutation(
  "/api/platform/channels",
  "POST",
  { login, fullConsent: fullConsent },
);

export const setPlatformFullConsent = (
  channelId: string,
  fullConsent: boolean,
): Promise<{ channel: PanelPlatformOverviewResponse["channels"][number] }> => requestMutation(
  `/api/platform/channels/${encodeURIComponent(channelId)}`,
  "PATCH",
  { fullConsent: fullConsent },
);

export const getPlatformMembers = (
  channelId: string,
  cursor: string | null = null,
): Promise<PanelPlatformMembersResponse> => {
  const parameter = new URLSearchParams();
  if (cursor !== null) parameter.set("cursor", cursor);
  const query = parameter.toString();
  return requestJson<PanelPlatformMembersResponse>(
    `/api/platform/channels/${encodeURIComponent(channelId)}/members${query.length > 0 ? `?${query}` : ""}`,
  );
};

export const addPlatformMember = (
  channelId: string,
  userId: string,
  role: "manager" | "operator",
): Promise<{ member: PanelPlatformMembersResponse["members"][number] }> => requestMutation(
  `/api/platform/channels/${encodeURIComponent(channelId)}/members`,
  "POST",
  { userId, role },
);

export const changePlatformMember = (
  channelId: string,
  userId: string,
  role: "manager" | "operator",
): Promise<{ member: PanelPlatformMembersResponse["members"][number] }> => requestMutation(
  `/api/platform/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
  "PATCH",
  { role },
);

export const removePlatformMember = (channelId: string, userId: string): Promise<undefined> =>
  requestMutation<undefined>(
    `/api/platform/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
    "DELETE",
  );

export const getPlatformAudit = (cursor: string | null = null): Promise<PanelPlatformAuditResponse> => {
  const parameter = new URLSearchParams();
  if (cursor !== null) parameter.set("cursor", cursor);
  const query = parameter.toString();
  return requestJson<PanelPlatformAuditResponse>(`/api/platform/audit${query.length > 0 ? `?${query}` : ""}`);
};

export const fetchChannelOverview = (
  channelId: string,
  signal?: AbortSignal,
): Promise<PanelChannelOverview> => requestJson<PanelChannelOverview>(
  channelPath(channelId, "overview"),
  requestOptions(signal),
);

export const fetchSystemOverview = (
  channelId: string,
  signal?: AbortSignal,
): Promise<PanelSystemResponse> => requestJson<PanelSystemResponse>(
  channelPath(channelId, "system"),
  requestOptions(signal),
);

export const fetchAuditLog = (
  channelId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
  filters?: PanelAuditFilters,
): Promise<PanelAuditResponse> => {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
  if (filters?.person !== null && filters?.person !== undefined) params.set("actor", filters.person);
  if (filters?.area !== null && filters?.area !== undefined) params.set("area", filters.area);
  const query = params.toString();
  return requestJson<PanelAuditResponse>(
    `${channelPath(channelId, "audit-log")}${query.length > 0 ? `?${query}` : ""}`,
    requestOptions(signal),
  );
};

export const fetchEvents = (
  channelId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
  filters?: PanelEventFilters,
): Promise<PanelEventsResponse> => {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
  if (filters?.origin !== null && filters?.origin !== undefined) {
    params.set("origin", filters.origin);
  }
  if (filters?.module !== null && filters?.module !== undefined) params.set("module", filters.module);
  if (filters?.tones !== undefined && filters.tones.length > 1) {
    for (const tone of filters.tones) params.append("tone", tone);
  } else if (filters?.tone !== null && filters?.tone !== undefined) params.set("tone", filters.tone);
  if (filters?.person !== null && filters?.person !== undefined) params.set("actor", filters.person);
  const query = params.toString();
  return requestJson<PanelEventsResponse>(
    `${channelPath(channelId, "events")}${query.length > 0 ? `?${query}` : ""}`,
    requestOptions(signal),
  );
};

export const fetchMembers = (
  channelId: string,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<PanelMembersResponse> => requestJson<PanelMembersResponse>(
  `${memberPath(channelId)}${cursor === null ? "" : `?${new URLSearchParams({ cursor }).toString()}`}`,
  requestOptions(signal),
);

export const fetchModules = (
  channelId: string,
  signal?: AbortSignal,
): Promise<PanelModulesResponse> => requestJson<PanelModulesResponse>(
  modulePath(channelId),
  requestOptions(signal),
);

export const searchTwitchUser = async (
  channelId: string,
  login: string,
  signal?: AbortSignal,
): Promise<{ user: PanelTwitchUser }> => {
  const params = new URLSearchParams({ login });
  return requestJson<{ user: PanelTwitchUser }>(
    `${memberPath(channelId)}/search?${params.toString()}`,
    requestOptions(signal),
  );
};

const requestMutation = <T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, string | boolean | number | null>,
): Promise<T> => requestJson<{ token: string }>("/api/csrf").then(({ token }) => requestJson<T>(path, {
  method,
  headers: {
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    "X-CSRF-Token": token,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

export const addChannelMember = (
  channelId: string,
  userId: string,
  role: ChannelRole,
): Promise<{ member: PanelMember }> => requestMutation(
  memberPath(channelId),
  "POST",
  { userId, role },
);

export const updateChannelMemberRole = (
  channelId: string,
  userId: string,
  role: ChannelRole,
): Promise<{ member: PanelMember }> => requestMutation(
  memberPath(channelId, userId),
  "PATCH",
  { role },
);

export const removeChannelMember = (channelId: string, userId: string): Promise<undefined> =>
  requestMutation<undefined>(memberPath(channelId, userId), "DELETE");

export const setChannelModuleEnabled = (
  channelId: string,
  moduleId: string,
  enabled: boolean,
): Promise<{ module: PanelModuleState }> => requestMutation(
  modulePath(channelId, moduleId),
  "PATCH",
  { enabled },
);

export const getChannelModuleSettings = (channelId: string, moduleId: string): Promise<{ settings: Record<string, unknown> }> =>
  requestJson<{ settings: Record<string, unknown> }>(`${modulePath(channelId, moduleId)}/settings`);

export const saveChannelModuleSettings = <Settings extends object>(
  channelId: string,
  moduleId: string,
  settings: Settings,
): Promise<{ settings: Settings; warnings: PanelTemplateWarningResponse["warnings"] }> => requestJson<{ token: string }>("/api/csrf")
  .then(({ token }) => requestJson<{ settings: Settings; warnings: PanelTemplateWarningResponse["warnings"] }>(`${modulePath(channelId, moduleId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify(settings),
  }));

export const refreshModeratorStatus = (
  channelId: string,
): Promise<{ moderator: PanelModeratorStatus; nextAllowedAt: string }> => requestMutation(
  channelPath(channelId, "moderator-status"),
  "POST",
);

export const startCommercial = (
  channelId: string,
  length: number,
): Promise<{ length: number | null; message: string | null; retryAfter: number | null }> => requestMutation(
  `${modulePath(channelId, "ads")}/commercial`,
  "POST",
  { length },
);

export const sendManualShoutout = (
  channelId: string,
  login: string,
): Promise<{ sent: true }> => requestMutation(
  channelPath(channelId, "shoutout"),
  "POST",
  { login },
);

export const createClip = (
  channelId: string,
): Promise<{ clipId: string | null; editUrl: string | null }> => requestMutation(
  channelPath(channelId, "clips"),
  "POST",
);

export const setChannelControl = (
  channelId: string,
  control: "mute" | "pause",
  duration: ChannelControlDuration | null,
): Promise<{ controls: PanelChannelControls }> => requestMutation(
  channelPath(channelId, `controls/${control}`),
  "POST",
  { duration },
);

export const logout = async (): Promise<void> => {
  const csrf = await requestJson<{ token: string }>("/api/csrf");
  await requestJson<undefined>("/auth/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
};
