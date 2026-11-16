import type { JsonObject } from "../../contract";
import { parseModuleOverlayConfig } from "../../contract";

export interface NowPlayingConfig { showCover: boolean; showRequester: boolean }
interface NowPlayingTrack { id: string; title: string; artist: string; coverUrl: string | null; spotifyUrl: string; requester: string | null; source: string }
export interface NowPlayingState { revision: number; track: NowPlayingTrack | null; serverNow: string; emptyText?: string }
export const DEFAULT_NOW_PLAYING_CONFIG: NowPlayingConfig = {
  showCover: true,
  showRequester: true,
};

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const parseNowPlayingConfig = (raw: unknown): NowPlayingConfig | null => parseModuleOverlayConfig(raw, (input) => {
    if (Object.keys(input).some((key) => !["showCover", "showRequester"].includes(key))) return null;
    const showCover = input.showCover ?? true;
    const showRequester = input.showRequester ?? true;
    return typeof showCover === "boolean" && typeof showRequester === "boolean" ? { showCover, showRequester } : null;
});
export const parseNowPlayingState = (raw: unknown): NowPlayingState | null => {
  const input = record(raw);
  if (input === null || !Number.isSafeInteger(input.revision) || typeof input.serverNow !== "string" || !Number.isFinite(Date.parse(input.serverNow))) return null;
  if (input.track === null) return { revision: input.revision as number, track: null, serverNow: input.serverNow, ...(typeof input.emptyText === "string" ? { emptyText: input.emptyText } : {}) };
  const track = record(input.track);
  if (track === null || typeof track.id !== "string" || typeof track.title !== "string" || typeof track.artist !== "string" ||
      !(track.coverUrl === null || typeof track.coverUrl === "string") || typeof track.spotifyUrl !== "string" ||
      !(track.requester === null || typeof track.requester === "string") || typeof track.source !== "string") return null;
  return { revision: input.revision as number, track: track as unknown as NowPlayingTrack, serverNow: input.serverNow, ...(typeof input.emptyText === "string" ? { emptyText: input.emptyText } : {}) };
};
export const mergeNowPlayingRevision = (current: Readonly<Record<string, unknown>> | null, incoming: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const previous = parseNowPlayingState(current);
  const nextRevision = incoming.revision;
  if (!Number.isSafeInteger(nextRevision) || previous !== null && (nextRevision as number) < previous.revision) return current ?? {};
  return { ...(current ?? {}), revision: nextRevision };
};
export const nowPlayingStateJson = (state: NowPlayingState): JsonObject => state as unknown as JsonObject;
