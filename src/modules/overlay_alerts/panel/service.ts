import { PanelApiError } from "../../../contracts/panel-error";
import type { MediaAssetMetadata } from "../contracts";

const basePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/overlay_alerts`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "string" ? payload.error : null;
    throw new PanelApiError(response.status, code, payload);
  }
  return payload as Value;
};

const csrf = async (): Promise<string> =>
  (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadMediaAssets = async (channelId: string, signal?: AbortSignal): Promise<MediaAssetMetadata[]> => {
  const response = await fetch(`${basePath(channelId)}/media`, signal === undefined ? {} : { signal });
  return (await readJson<{ assets: MediaAssetMetadata[] }>(response)).assets;
};

export const uploadMediaAsset = async (channelId: string, file: File): Promise<MediaAssetMetadata> => {
  const token = await csrf();
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${basePath(channelId)}/media`, {
    method: "POST",
    headers: { "X-CSRF-Token": token },
    body: form,
  });
  return (await readJson<{ asset: MediaAssetMetadata }>(response)).asset;
};

export const deleteMediaAsset = async (channelId: string, id: string): Promise<void> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}/media/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": token },
  });
  if (response.status === 204) return;
  await readJson<unknown>(response);
};

export const mediaAssetUrl = (channelId: string, asset: Pick<MediaAssetMetadata, "id" | "sha256">): string =>
  `${basePath(channelId)}/media/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.sha256)}`;
