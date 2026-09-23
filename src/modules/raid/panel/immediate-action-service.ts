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

export const sendManualShoutout = async (channelId: string, login: string): Promise<{ sent: true }> => {
  const csrf = await readJson<{ token: string }>(await fetch("/api/csrf"));
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/shoutout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify({ login }),
  });
  return readJson<{ sent: true }>(response);
};
