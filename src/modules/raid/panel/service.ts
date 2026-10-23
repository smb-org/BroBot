import { PanelApiError } from "../../../contracts/panel-error";

export interface RaidPanelState {
  ready: boolean;
  shoutoutThreshold: number | null;
  lastRaid: { channel: string | null; viewers: number | null; at: string } | null;
  lastShoutout: { channel: string | null; at: string } | null;
}

export const loadRaidPanelState = async (channelId: string, signal?: AbortSignal): Promise<RaidPanelState> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/raid/state`, signal === undefined ? {} : { signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new PanelApiError(response.status, code, body);
  }
  return body as RaidPanelState;
};
