import { PanelApiError } from "../../../contracts/panel-error";
import type { ModuleTempVipPerson, ModuleTempVipResult, ModuleTempVipRow } from "../../contract";
import type { TempVipsSettings } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/temp_vips`;

export interface TempVipsPanelData {
  rows: ModuleTempVipRow[];
  settings: TempVipsSettings;
  timeZone: string;
  now: string;
}

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
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

export const loadExistingVips = async (channelId: string, signal?: AbortSignal): Promise<ModuleTempVipPerson[]> => {
  const response = await readJson<{ people: ModuleTempVipPerson[] }>(await fetch(
    `${modulePath(channelId)}/existing-vips`,
    signal === undefined ? undefined : { signal },
  ));
  return response.people;
};

const mutate = async (channelId: string, path: string, body: Record<string, unknown>): Promise<ModuleTempVipResult> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson<ModuleTempVipResult>(await fetch(`${modulePath(channelId)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }),
  }));
};

export const grantTempVip = (channelId: string, login: string, durationMs: number): Promise<ModuleTempVipResult> =>
  mutate(channelId, "/vips/grant", { login, durationMs });

export const importTempVip = (channelId: string, userId: string, durationMs: number): Promise<ModuleTempVipResult> =>
  mutate(channelId, "/vips/import", { userId, durationMs });

export const extendTempVip = (channelId: string, userId: string, durationMs: number): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/extend`, { durationMs });

export const endTempVip = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/end`, {});

export const releaseTempVip = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/release`, {});

export const retryTempVipRemoval = (channelId: string, userId: string): Promise<ModuleTempVipResult> =>
  mutate(channelId, `/vips/${encodeURIComponent(userId)}/retry`, {});

