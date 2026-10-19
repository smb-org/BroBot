import { PanelApiError } from "../../../contracts/panel-error";
import { clipsSettingsSchema, type ClipsSettings, type SessionClipList } from "../contracts";

const modulePath = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/clips`;

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

export const loadClipsSettings = (
  channelId: string,
  signal?: AbortSignal,
): Promise<{ settings: ClipsSettings; revision: number }> => fetch(
  `${modulePath(channelId)}/settings`,
  signal === undefined ? undefined : { signal },
).then(async (response) => {
  const result = await readJson<{ settings: unknown; revision: number }>(response);
  return { ...result, settings: clipsSettingsSchema.parse(result.settings) };
});

export const saveClipsSettings = async (
  channelId: string,
  revision: number,
  settings: ClipsSettings,
): Promise<{ settings: ClipsSettings; revision: number }> => {
  const { token } = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const result = await readJson<{ settings: unknown; revision: number }>(await fetch(`${modulePath(channelId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ revision, settings }),
  }));
  return { ...result, settings: clipsSettingsSchema.parse(result.settings) };
};

export const loadSessionClips = (
  channelId: string,
  signal?: AbortSignal,
): Promise<SessionClipList> => fetch(
  `/api/channels/${encodeURIComponent(channelId)}/clips`,
  signal === undefined ? undefined : { signal },
).then((response) => readJson<SessionClipList>(response));

export const createClip = async (channelId: string): Promise<{ clipId: string | null; editUrl: string | null }> => {
  const { token } = await readJson<{ token: string }>(await fetch("/api/csrf"));
  return readJson(await fetch(`/api/channels/${encodeURIComponent(channelId)}/clips`, {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  }));
};
