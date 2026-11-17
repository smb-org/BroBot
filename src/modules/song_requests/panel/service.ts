import type { SongRequestsSettings } from "../contracts";
import type { SongRequestStatistics } from "../contracts";

const route = (channelId: string, part: string): string => `/api/channels/${encodeURIComponent(channelId)}/modules/song_requests/${part}`;

/** Module-owned JSON request; mutations fetch a CSRF token first. Failures throw an Error whose message is the API error code. */
export const request = async <T,>(channelId: string, part: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> => {
  const headers = new Headers(body === undefined ? undefined : { "Content-Type": "application/json" });
  if (method !== "GET" && method !== "HEAD") {
    const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin" });
    if (!csrfResponse.ok) throw new Error("csrf_unavailable");
    const csrf = await csrfResponse.json<{ token?: unknown }>();
    if (typeof csrf.token !== "string") throw new Error("csrf_unavailable");
    headers.set("X-CSRF-Token", csrf.token);
  }
  const response = await fetch(route(channelId, part), {
    method,
    credentials: "same-origin",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    let error = "request_failed";
    try { const payload = await response.json<{ error?: string }>(); error = payload.error ?? error; } catch { /* Keep fallback. */ }
    throw new Error(error);
  }
  return await response.json<T>();
};

export interface SongRequestsSettingsRead { settings: SongRequestsSettings; revision: number }

export const readSettings = (channelId: string, signal?: AbortSignal): Promise<SongRequestsSettingsRead> =>
  request<SongRequestsSettingsRead>(channelId, "settings", "GET", undefined, signal);

export const saveSettings = (channelId: string, revision: number, settings: SongRequestsSettings): Promise<SongRequestsSettingsRead> =>
  request<SongRequestsSettingsRead>(channelId, "settings", "PATCH", { revision, settings });

export const skipSong = async (channelId: string): Promise<"skipped" | "nothing_playing" | "track_changed" | "not_connected" | "no_active_device" | "spotify_unavailable"> =>
  (await request<{ outcome: "skipped" | "nothing_playing" | "track_changed" | "not_connected" | "no_active_device" | "spotify_unavailable" }>(
    channelId, "skip", "POST",
  )).outcome;

export const readSongRequestStatistics = (
  channelId: string,
  scope: { kind: "stream"; streamId: string } | { kind: "total" },
  signal?: AbortSignal,
): Promise<SongRequestStatistics> => {
  const query = scope.kind === "stream"
    ? `statistics?scope=stream&streamId=${encodeURIComponent(scope.streamId)}`
    : "statistics?scope=total";
  return request<SongRequestStatistics>(channelId, query, "GET", undefined, signal);
};
