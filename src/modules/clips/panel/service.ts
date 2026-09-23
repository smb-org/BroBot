import { PanelApiError } from "../../../contracts/panel-error";

const readJson = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as T;
};

export const createClip = async (channelId: string): Promise<{ clipId: string | null; editUrl: string | null }> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/clips`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
  return readJson<{ clipId: string | null; editUrl: string | null }>(response);
};
