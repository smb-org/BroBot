import type {
  PanelAuditResponse,
  PanelBetreiberMitgliederResponse,
  PanelBetreiberAuditResponse,
  PanelBetreiberÜbersichtResponse,
  PanelChannelOverview,
  PanelChannelsResponse,
  PanelChannelRole,
  PanelEventsResponse,
  PanelMember,
  PanelMembersResponse,
  PanelModeratorStatus,
  PanelModuleState,
  PanelModulesResponse,
  PanelSystemResponse,
  PanelTwitchUser,
} from "../panel-contract";

export class PanelApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = "PanelApiError";
  }
}

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
  pathname === "/api/betreiber" ||
  pathname.startsWith("/api/betreiber/") ||
  pathname === "/api/csrf" ||
  pathname === "/auth/logout";

const resolveRequestUrl = (input: string): URL => {
  let url: URL;
  try {
    url = new URL(input, window.location.origin);
  } catch {
    throw new PanelApiError(400, "Die Panel-Anfrage ist nicht erlaubt.");
  }
  if (url.origin !== window.location.origin || hasParentPathSegment(input) || !isAllowedRequestPath(url.pathname)) {
    throw new PanelApiError(400, "Die Panel-Anfrage ist nicht erlaubt.");
  }
  return url;
};

export const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const url = resolveRequestUrl(input);
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const responseText = await response.text();
    let message = responseText || "Die Panel-Anfrage ist fehlgeschlagen.";
    let details: unknown = null;
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        details = parsed;
        const error = (parsed as Record<string, unknown>).error;
        if (typeof error === "string" && error.length > 0) message = error;
      }
    } catch {
      // Fehlerantworten dürfen auch reiner Text sein.
    }
    throw new PanelApiError(response.status, message, details);
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

export const holeBetreiberÜbersicht = (): Promise<PanelBetreiberÜbersichtResponse> =>
  requestJson<PanelBetreiberÜbersichtResponse>("/api/betreiber");

export const sucheBetreiberNutzer = (login: string): Promise<{ user: PanelTwitchUser }> =>
  requestJson<{ user: PanelTwitchUser }>(`/api/betreiber/nutzer?${new URLSearchParams({ login }).toString()}`);

export const gibBetreiberKanalFrei = (
  login: string,
  vollzustimmung: boolean,
): Promise<{ channel: PanelBetreiberÜbersichtResponse["channels"][number] }> => requestMutation(
  "/api/betreiber/kanaele",
  "POST",
  { login, vollzustimmung },
);

export const setzeBetreiberVollzustimmung = (
  channelId: string,
  vollzustimmung: boolean,
): Promise<{ channel: PanelBetreiberÜbersichtResponse["channels"][number] }> => requestMutation(
  `/api/betreiber/kanaele/${encodeURIComponent(channelId)}`,
  "PATCH",
  { vollzustimmung },
);

export const holeBetreiberMitglieder = (
  channelId: string,
  cursor: string | null = null,
): Promise<PanelBetreiberMitgliederResponse> => {
  const parameter = new URLSearchParams();
  if (cursor !== null) parameter.set("cursor", cursor);
  const query = parameter.toString();
  return requestJson<PanelBetreiberMitgliederResponse>(
    `/api/betreiber/kanaele/${encodeURIComponent(channelId)}/mitglieder${query.length > 0 ? `?${query}` : ""}`,
  );
};

export const fügeBetreiberMitgliedHinzu = (
  channelId: string,
  userId: string,
  role: "verwalter" | "bediener",
): Promise<{ member: PanelBetreiberMitgliederResponse["members"][number] }> => requestMutation(
  `/api/betreiber/kanaele/${encodeURIComponent(channelId)}/mitglieder`,
  "POST",
  { userId, role },
);

export const ändereBetreiberMitglied = (
  channelId: string,
  userId: string,
  role: "verwalter" | "bediener",
): Promise<{ member: PanelBetreiberMitgliederResponse["members"][number] }> => requestMutation(
  `/api/betreiber/kanaele/${encodeURIComponent(channelId)}/mitglieder/${encodeURIComponent(userId)}`,
  "PATCH",
  { role },
);

export const entferneBetreiberMitglied = (channelId: string, userId: string): Promise<undefined> =>
  requestMutation<undefined>(
    `/api/betreiber/kanaele/${encodeURIComponent(channelId)}/mitglieder/${encodeURIComponent(userId)}`,
    "DELETE",
  );

export const holeBetreiberAudit = (cursor: string | null = null): Promise<PanelBetreiberAuditResponse> => {
  const parameter = new URLSearchParams();
  if (cursor !== null) parameter.set("cursor", cursor);
  const query = parameter.toString();
  return requestJson<PanelBetreiberAuditResponse>(`/api/betreiber/audit${query.length > 0 ? `?${query}` : ""}`);
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
): Promise<PanelAuditResponse> => {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
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
): Promise<PanelEventsResponse> => {
  const params = new URLSearchParams();
  if (cursor !== null) params.set("cursor", cursor);
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
  body?: Record<string, string | boolean>,
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
  role: PanelChannelRole,
): Promise<{ member: PanelMember }> => requestMutation(
  memberPath(channelId),
  "POST",
  { userId, role },
);

export const updateChannelMemberRole = (
  channelId: string,
  userId: string,
  role: PanelChannelRole,
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

export const refreshModeratorStatus = (
  channelId: string,
): Promise<{ moderator: PanelModeratorStatus; nextAllowedAt: string }> => requestMutation(
  channelPath(channelId, "moderator-status"),
  "POST",
);

export const logout = async (): Promise<void> => {
  const csrf = await requestJson<{ token: string }>("/api/csrf");
  await requestJson<undefined>("/auth/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
};
