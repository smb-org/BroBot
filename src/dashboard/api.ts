import type {
  PanelAuditResponse,
  PanelChannelOverview,
  PanelChannelsResponse,
  PanelSystemResponse,
} from "../panel-contract";

export class PanelApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PanelApiError";
  }
}

const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const message = (await response.text()) || "Die Panel-Anfrage ist fehlgeschlagen.";
    throw new PanelApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
};

const requestOptions = (signal: AbortSignal | undefined): RequestInit | undefined =>
  signal === undefined ? undefined : { signal };

const channelPath = (channelId: string, suffix: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;

export const fetchChannels = (signal?: AbortSignal): Promise<PanelChannelsResponse> =>
  requestJson<PanelChannelsResponse>("/api/channels", requestOptions(signal));

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

export const logout = async (): Promise<void> => {
  const csrf = await requestJson<{ token: string }>("/api/csrf");
  await requestJson<undefined>("/auth/logout", {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
};
