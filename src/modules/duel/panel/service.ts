import { PanelApiError } from "../../../contracts/panel-error";

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const cancelDuelRound = async (channelId: string, roundId: string): Promise<void> => {
  const token = await csrf();
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/duel/rounds/${encodeURIComponent(roundId)}/cancel`, {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  });
  if (response.status !== 204) await readJson<unknown>(response);
};
