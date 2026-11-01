import { PanelApiError } from "../../../contracts/panel-error";
import type { ModuleTempVipPerson, ModuleTempVipResult, ModuleTempVipRow } from "../../contract";
import type { TempVipsSettings } from "../contracts";
import { createTempVipSubmissionTracker } from "./submission";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/temp_vips`;
const submissionTracker = createTempVipSubmissionTracker();

export interface TempVipsPanelData {
  rows: ModuleTempVipRow[];
  settings: TempVipsSettings;
  timeZone: string;
  now: string;
}

const readJson = async <Value,>(response: Response): Promise<Value> => {
  // A lost or unreadable 2xx body is ambiguous (the server may have committed): a non-PanelApiError keeps the operation id.
  const body: unknown = response.ok ? await response.json() : await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

export const loadTempVips = async (channelId: string, signal?: AbortSignal): Promise<TempVipsPanelData> =>
  readJson<TempVipsPanelData>(await fetch(`${modulePath(channelId)}/vips`, signal === undefined ? undefined : { signal }));

export interface TempVipActionReadiness {
  ready: boolean;
  missingScopes: string[];
  metadataUnknown: boolean;
}

export const loadTempVipActionReadiness = async (channelId: string, signal?: AbortSignal): Promise<TempVipActionReadiness> => {
  const response = await readJson<{
    modules: Array<{ id: string; missingBroadcasterScopes?: string[]; broadcasterScopeMetadataUnknown?: true }>;
  }>(await fetch(
    `/api/channels/${encodeURIComponent(channelId)}/modules`,
    signal === undefined ? undefined : { signal },
  ));
  const module = response.modules.find(({ id }) => id === "temp_vips");
  if (module === undefined || module.broadcasterScopeMetadataUnknown === true) {
    return { ready: false, missingScopes: [], metadataUnknown: true };
  }
  const missingScopes = module.missingBroadcasterScopes ?? [];
  return { ready: missingScopes.length === 0, missingScopes, metadataUnknown: false };
};

export const loadExistingVips = async (channelId: string, signal?: AbortSignal): Promise<ModuleTempVipPerson[]> => {
  const response = await readJson<{ people: ModuleTempVipPerson[] }>(await fetch(
    `${modulePath(channelId)}/existing-vips`,
    signal === undefined ? undefined : { signal },
  ));
  return response.people;
};

const mutate = async (channelId: string, path: string, body: Record<string, unknown>): Promise<ModuleTempVipResult> => {
  return submissionTracker.submit(`${channelId}:${path}`, body, async (operationId) => {
    const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
    const result = await readJson<ModuleTempVipResult | null>(await fetch(`${modulePath(channelId)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
      body: JSON.stringify({ ...body, operationId }),
    }));
    if (result === null || typeof result.status !== "string") {
      throw new TypeError("Invalid temporary VIP response body");
    }
    return result;
  });
};

export const grantTempVip = (channelId: string, login: string, durationMs: number): Promise<ModuleTempVipResult> =>
  mutate(channelId, "/vips/grant", { login, durationMs });

export const importTempVip = (channelId: string, userId: string, duration: number | { expiresAtLocal: string }): Promise<ModuleTempVipResult> =>
  mutate(channelId, "/vips/import", { userId, ...(typeof duration === "number" ? { durationMs: duration } : duration) });

export const extendTempVip = (channelId: string, userId: string, durationMs: number): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/extend`, { durationMs });

export const endTempVip = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/end`, {});

export const releaseTempVip = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/release`, {});

export const retryTempVipRemoval = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/retry`, {});

