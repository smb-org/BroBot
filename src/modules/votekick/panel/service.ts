import { PanelApiError } from "../../../contracts/panel-error";
import type { Votekick } from "../contracts";

export interface VotekickPanelData {
  running: Votekick | null;
  votekicks: readonly Votekick[];
  now: string;
}

const basePath = (channelId: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/votekick`;

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as Value;
};

const csrf = async (): Promise<string> => (await readJson<{ token: string }>(await fetch("/api/csrf"))).token;

export const loadVotekickPanel = async (channelId: string, signal?: AbortSignal): Promise<VotekickPanelData> =>
  readJson<VotekickPanelData>(await fetch(`${basePath(channelId)}/votekicks`, signal === undefined ? {} : { signal }));

const mutate = async (channelId: string, id: string, action: "cancel" | "lift"): Promise<void> => {
  const token = await csrf();
  const response = await fetch(`${basePath(channelId)}/votekicks/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  });
  if (response.status === 204) return;
  await readJson<unknown>(response);
};

export const cancelVotekick = (channelId: string, id: string): Promise<void> => mutate(channelId, id, "cancel");
export const liftVotekickTimeout = (channelId: string, id: string): Promise<void> => mutate(channelId, id, "lift");
