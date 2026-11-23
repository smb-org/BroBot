import type { JsonObject } from "../../contract";
import { parseModuleOverlayConfig } from "../../contract";

type NowPlayingDisplayMode = "always" | "playing" | "on_change";
export interface NowPlayingConfig {
  displayMode: NowPlayingDisplayMode;
  showDurationSeconds: number;
  showCover: boolean;
  showTitle: boolean;
  showArtist: boolean;
  showAlbum: boolean;
  showProgress: boolean;
  showTime: boolean;
  showRequester: boolean;
}
interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  coverUrl: string | null;
  spotifyUrl: string;
  requester: string | null;
  source: string;
  durationMs?: number;
  progressMs?: number | null;
  playing?: boolean;
}
export interface NowPlayingState { revision: number; track: NowPlayingTrack | null; serverNow: string; playing: boolean; emptyText?: string }
export const DEFAULT_NOW_PLAYING_CONFIG: NowPlayingConfig = {
  displayMode: "always",
  showDurationSeconds: 8,
  showCover: true,
  showTitle: true,
  showArtist: true,
  showAlbum: false,
  showTime: true,
  showRequester: true,
  showProgress: true,
};

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const parseNowPlayingConfig = (raw: unknown): NowPlayingConfig | null => parseModuleOverlayConfig(raw, (input) => {
    if (Object.keys(input).some((key) => ![
      "displayMode", "showDurationSeconds", "showCover", "showTitle", "showArtist", "showAlbum", "showProgress", "showTime", "showRequester",
    ].includes(key))) return null;
    const value = (key: keyof NowPlayingConfig): unknown => Object.hasOwn(input, key) ? input[key] : DEFAULT_NOW_PLAYING_CONFIG[key];
    const displayMode = value("displayMode");
    const showDurationSeconds = value("showDurationSeconds");
    const showCover = value("showCover");
    const showTitle = value("showTitle");
    const showArtist = value("showArtist");
    const showAlbum = value("showAlbum");
    const showProgress = value("showProgress");
    const showTime = Object.hasOwn(input, "showTime")
      ? input.showTime
      : Object.hasOwn(input, "showProgress") ? input.showProgress : DEFAULT_NOW_PLAYING_CONFIG.showTime;
    const showRequester = value("showRequester");
    if (!(displayMode === "always" || displayMode === "playing" || displayMode === "on_change") ||
        typeof showDurationSeconds !== "number" || !Number.isFinite(showDurationSeconds) ||
        typeof showCover !== "boolean" || typeof showTitle !== "boolean" || typeof showArtist !== "boolean" ||
        typeof showAlbum !== "boolean" || typeof showProgress !== "boolean" || typeof showTime !== "boolean" || typeof showRequester !== "boolean") return null;
    return {
      displayMode,
      showDurationSeconds: Math.max(2, Math.min(60, Math.trunc(showDurationSeconds))),
      showCover,
      showTitle,
      showArtist,
      showAlbum,
      showProgress,
      showTime,
      showRequester,
    };
});
export const parseNowPlayingState = (raw: unknown): NowPlayingState | null => {
  const input = record(raw);
  if (input === null || !Number.isSafeInteger(input.revision) || typeof input.serverNow !== "string" || !Number.isFinite(Date.parse(input.serverNow))) return null;
  const playing = input.playing !== false;
  if (input.track === null) return { revision: input.revision as number, track: null, serverNow: input.serverNow, playing, ...(typeof input.emptyText === "string" ? { emptyText: input.emptyText } : {}) };
  const track = record(input.track);
  if (track === null || typeof track.id !== "string" || typeof track.title !== "string" || typeof track.artist !== "string" ||
      !(track.coverUrl === null || typeof track.coverUrl === "string") || typeof track.spotifyUrl !== "string" ||
      !(track.requester === null || typeof track.requester === "string") || typeof track.source !== "string" ||
      track.album !== undefined && track.album !== null && typeof track.album !== "string" ||
      track.albumName !== undefined && track.albumName !== null && typeof track.albumName !== "string" ||
      track.durationMs !== undefined && (typeof track.durationMs !== "number" || !Number.isFinite(track.durationMs) || track.durationMs < 0) ||
      track.progressMs !== undefined && track.progressMs !== null && (typeof track.progressMs !== "number" || !Number.isFinite(track.progressMs) || track.progressMs < 0) ||
      track.playing !== undefined && typeof track.playing !== "boolean") return null;
  const album = track.album === undefined ? track.albumName : track.album;
  const normalizedTrack = { ...track, ...(album === undefined ? {} : { album }) };
  return { revision: input.revision as number, track: normalizedTrack as unknown as NowPlayingTrack, serverNow: input.serverNow, playing, ...(typeof input.emptyText === "string" ? { emptyText: input.emptyText } : {}) };
};
export const mergeNowPlayingRevision = (current: Readonly<Record<string, unknown>> | null, incoming: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const previous = parseNowPlayingState(current);
  const nextRevision = incoming.revision;
  if (!Number.isSafeInteger(nextRevision) || previous !== null && (nextRevision as number) < previous.revision) return current ?? {};
  return { ...(current ?? {}), revision: nextRevision };
};
export const nowPlayingStateJson = (state: NowPlayingState): JsonObject => state as unknown as JsonObject;
