import type { AdsSettings, AdsScheduleResponse } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";

const emptySettings: AdsSettings = {
  automatic: "",
  manual: "",
  prewarning: true,
  leadSeconds: 60,
  prewarningText: "Ads in {seconds} seconds. Be right back!",
};

const emptySchedule: AdsScheduleResponse = {
  schedule: {
    nextAdAt: null,
    duration: null,
    lastAdAt: null,
    prerollFreeTime: null,
    snoozeCount: null,
    snoozeRefreshAt: null,
  },
  recentAdBreaks: [],
  snoozeScopeAvailable: false,
};

const pathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/ads/settings`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new PanelApiError(
    response.status,
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : null,
    body,
  );
  return body as T;
};

export const loadAdSettings = async (channelId: string): Promise<AdsSettings> => {
  const response = await fetch(pathFor(channelId));
  const loaded = (await json<{ settings: Partial<AdsSettings> }>(response)).settings;
  return { ...emptySettings, ...loaded };
};

const schedulePathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/ads/schedule`;

export const loadAdsSchedule = async (channelId: string): Promise<AdsScheduleResponse> => {
  const response = await fetch(schedulePathFor(channelId));
  const loadedResponse = await json<Partial<AdsScheduleResponse> | null>(response);
  const loaded = loadedResponse !== null && typeof loadedResponse === "object" ? loadedResponse : {};
  return {
    ...emptySchedule,
    ...loaded,
    schedule: { ...emptySchedule.schedule, ...(loaded.schedule ?? {}) },
    recentAdBreaks: loaded.recentAdBreaks ?? [],
  };
};

export const saveAdSettings = async (
  channelId: string,
  settings: AdsSettings,
): Promise<void> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  await json(await fetch(pathFor(channelId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify(settings),
  }));
};

export const snoozeAds = async (channelId: string): Promise<AdsScheduleResponse> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/ads/snooze`, {
    method: "POST",
    headers: { "X-CSRF-Token": csrf.token },
  });
  return json<AdsScheduleResponse>(response);
};
