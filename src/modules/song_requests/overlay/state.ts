import type { JsonObject } from "../../contract";
import { parseModuleOverlayConfig } from "../../contract";

export interface NowPlayingConfig { showCover: boolean; showRequester: boolean; showProgress: boolean }
interface NowPlayingTrack {
  id: string;
  title: string;
  artist: string;
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
  showCover: true,
  showRequester: true,
  showProgress: true,
};

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const parseNowPlayingConfig = (raw: unknown): NowPlayingConfig | null => parseModuleOverlayConfig(raw, (input) => {
    if (Object.keys(input).some((key) => !["showCover", "showRequester", "showProgress"].includes(key))) return null;
    const showCover = input.showCover ?? true;
    const showRequester = input.showRequester ?? true;
    const showProgress = input.showProgress ?? true;
    return typeof showCover === "boolean" && typeof showRequester === "boolean" && typeof showProgress === "boolean"
      ? { showCover, showRequester, showProgress } : null;
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
      track.durationMs !== undefined && (typeof track.durationMs !== "number" || !Number.isFinite(track.durationMs) || track.durationMs < 0) ||
      track.progressMs !== undefined && track.progressMs !== null && (typeof track.progressMs !== "number" || !Number.isFinite(track.progressMs) || track.progressMs < 0) ||
      track.playing !== undefined && typeof track.playing !== "boolean") return null;
  return { revision: input.revision as number, track: track as unknown as NowPlayingTrack, serverNow: input.serverNow, playing, ...(typeof input.emptyText === "string" ? { emptyText: input.emptyText } : {}) };
};
export const mergeNowPlayingRevision = (current: Readonly<Record<string, unknown>> | null, incoming: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const previous = parseNowPlayingState(current);
  const nextRevision = incoming.revision;
  if (!Number.isSafeInteger(nextRevision) || previous !== null && (nextRevision as number) < previous.revision) return current ?? {};
  return { ...(current ?? {}), revision: nextRevision };
};
export const nowPlayingStateJson = (state: NowPlayingState): JsonObject => state as unknown as JsonObject;
