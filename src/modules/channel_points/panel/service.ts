import { PanelApiError } from "../../../contracts/panel-error";
import type {
  ChannelPointsRedemption,
  ChannelPointsReward,
  ChannelPointsRewardInput,
} from "../contracts";

const basePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/channel_points`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
    throw new PanelApiError(response.status, code, payload);
  }
  return payload as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

const request = async <Value,>(
  channelId: string,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<Value> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}${path}`, {
    method,
    headers: { "X-CSRF-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as Value;
  return readJson<Value>(response);
};

export interface ChannelPointsPanelState {
  rewards: ChannelPointsReward[];
  moduleEnabled: boolean;
  connection: { connected: boolean; scopes: string[]; missingScopes: string[] };
}

export interface ChannelPointsHistoryPage {
  items: ChannelPointsRedemption[];
  cursor: string | null;
}

export interface ChannelPointsModuleAvailability {
  id: string;
  enabled: boolean;
}

export const loadChannelPointsState = async (channelId: string, signal?: AbortSignal): Promise<ChannelPointsPanelState> =>
  readJson<ChannelPointsPanelState>(await fetch(
    `${basePath(channelId)}/state`, signal === undefined ? {} : { signal },
  ));

export const loadChannelPointsRedemptions = async (
  channelId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ChannelPointsHistoryPage> => {
  const search = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return readJson<ChannelPointsHistoryPage>(await fetch(
    `${basePath(channelId)}/redemptions${search}`, signal === undefined ? {} : { signal },
  ));
};

export const loadChannelPointsModuleAvailability = async (
  channelId: string,
  signal?: AbortSignal,
): Promise<ChannelPointsModuleAvailability[]> => {
  const response = await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/modules`, signal === undefined ? {} : { signal },
  );
  const payload = await readJson<{ modules?: unknown }>(response);
  if (!Array.isArray(payload.modules)) return [];
  return payload.modules.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.enabled !== "boolean") return [];
    return [{ id: candidate.id, enabled: candidate.enabled }];
  });
};

export const createChannelPointsReward = async (
  channelId: string,
  input: ChannelPointsRewardInput,
): Promise<ChannelPointsReward> => (await request<{ reward: ChannelPointsReward }>(
  channelId, "/rewards", "POST", input,
)).reward;

export const updateChannelPointsReward = async (
  channelId: string,
  id: string,
  input: ChannelPointsRewardInput,
): Promise<ChannelPointsReward> => (await request<{ reward: ChannelPointsReward }>(
  channelId, `/rewards/${encodeURIComponent(id)}`, "PUT", input,
)).reward;

export const deleteChannelPointsReward = async (channelId: string, id: string): Promise<void> => {
  await request<{ ok: true }>(channelId, `/rewards/${encodeURIComponent(id)}`, "DELETE");
};

export const recreateChannelPointsReward = async (channelId: string, id: string): Promise<ChannelPointsReward> =>
  (await request<{ reward: ChannelPointsReward }>(
    channelId, `/rewards/${encodeURIComponent(id)}/recreate`, "POST",
  )).reward;

export const reconcileChannelPoints = async (channelId: string): Promise<{ ok: boolean; failedRewards?: unknown[] }> =>
  request<{ ok: boolean; failedRewards?: unknown[] }>(channelId, "/reconcile", "POST", {});
