import type { AdsSettings, AdsScheduleResponse } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";

const leereEinstellungen: AdsSettings = {
  automatic: "",
  manual: "",
  prewarning: true,
  leadSeconds: 60,
  prewarningText: "Werbung in {seconds} Sekunden. Bin gleich zurück!",
};

const leererZeitplan: AdsScheduleResponse = {
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
      : "Anfrage fehlgeschlagen.",
    body,
  );
  return body as T;
};

export const loadAdSettings = async (channelId: string): Promise<AdsSettings> => {
  const response = await fetch(pathFor(channelId));
  const loaded = (await json<{ settings: Partial<AdsSettings> }>(response)).settings;
  return { ...leereEinstellungen, ...loaded };
};

const zeitplanPathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/ads/zeitplan`;

export const loadAdsSchedule = async (channelId: string): Promise<AdsScheduleResponse> => {
  const response = await fetch(zeitplanPathFor(channelId));
  const loadedResponse = await json<Partial<AdsScheduleResponse> | null>(response);
  const loaded = loadedResponse !== null && typeof loadedResponse === "object" ? loadedResponse : {};
  return {
    ...leererZeitplan,
    ...loaded,
    schedule: { ...leererZeitplan.schedule, ...(loaded.schedule ?? {}) },
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
