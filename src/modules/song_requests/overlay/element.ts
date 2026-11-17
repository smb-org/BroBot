import type { JsonObject, ModuleOverlayElementContext, ModuleOverlayElementDefinition } from "../../contract";
import { SONG_REQUESTS_NOW_PLAYING_KIND, SONG_REQUESTS_NOW_PLAYING_SIZE } from "./kinds";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, mergeNowPlayingRevision, nowPlayingStateJson, parseNowPlayingConfig, parseNowPlayingState } from "./state";

const sample = (now: number): JsonObject => nowPlayingStateJson({
  revision: 1,
  serverNow: new Date(now).toISOString(),
  track: { id: "fictionaltrack01", title: "Glass Harbor", artist: "Mira Vale", coverUrl: "https://i.scdn.co/image/fictional-cover-one", spotifyUrl: "https://open.spotify.com/track/fictionaltrack01", requester: "Song vote", source: "mod_vote", durationMs: 240000, progressMs: 93000 },
  playing: true,
});

export const songRequestsNowPlayingElement: ModuleOverlayElementDefinition = {
  kind: SONG_REQUESTS_NOW_PLAYING_KIND,
  configVersion: 1,
  defaultSize: SONG_REQUESTS_NOW_PLAYING_SIZE,
  defaultConfig: DEFAULT_NOW_PLAYING_CONFIG as unknown as JsonObject,
  previewState: (_config, _language, now) => sample(now),
  editorLabel: { de: nowPlayingTexts.de.name, en: nowPlayingTexts.en.name },
  editorAddLabel: { de: nowPlayingTexts.de.name, en: nowPlayingTexts.en.name },
  editorDescription: { de: nowPlayingTexts.de.description, en: nowPlayingTexts.en.description },
  editorModuleLabel: { de: nowPlayingTexts.de.moduleLabel, en: nowPlayingTexts.en.moduleLabel },
  initialStateNeedsContext: true,
  reloadStateOnModuleMessages: ["modul.song_requests.state_changed"],
  mergeRealtimeStateOnModuleMessages: ["modul.song_requests.state_changed"],
  mergeRealtimeState: mergeNowPlayingRevision,
  parseConfig: (raw) => {
    const parsed = parseNowPlayingConfig(raw);
    return parsed === null ? null : parsed as unknown as JsonObject;
  },
  initialState: async (db, channelId, _config, context?: ModuleOverlayElementContext) => {
    const [snapshot, settings] = await Promise.all([
      db.prepare("SELECT revision, track_json, progress_ms, observed_at FROM song_requests_now_playing WHERE channel_id = ?").bind(channelId)
        .first<{ revision: number; track_json: string | null; progress_ms: number | null; observed_at: string | null }>(),
      db.prepare("SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'").bind(channelId).first<{ settings: string }>(),
    ]);
    let emptyText = "";
    try {
      const parsed: unknown = JSON.parse(settings?.settings ?? "{}");
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as Record<string, unknown>).emptyText === "string") emptyText = (parsed as { emptyText: string }).emptyText;
    } catch { /* Invalid legacy settings use the empty default. */ }
    let track: unknown = null;
    if (snapshot?.track_json != null) {
      try { track = JSON.parse(snapshot.track_json); } catch { track = null; }
    }
    if (typeof track === "object" && track !== null && !Array.isArray(track)) {
      const trackRecord = track as Record<string, unknown>;
      if (trackRecord.progressMs === undefined) trackRecord.progressMs = snapshot?.progress_ms ?? null;
    }
    const revision = snapshot?.revision ?? 0;
    const storedServerNow = typeof track === "object" && track !== null && !Array.isArray(track)
      ? (track as Record<string, unknown>).serverNow : undefined;
    const storedPlaying = typeof track === "object" && track !== null && !Array.isArray(track) &&
      typeof (track as Record<string, unknown>).playing === "boolean"
      ? (track as Record<string, unknown>).playing as boolean
      : true;
    const serverNow = typeof storedServerNow === "string" && Number.isFinite(Date.parse(storedServerNow))
      ? storedServerNow
      : snapshot?.observed_at ?? new Date(context?.now ?? Date.now()).toISOString();
    return nowPlayingStateJson(parseNowPlayingState({ revision, serverNow, track, playing: storedPlaying, emptyText })
      ?? { revision, serverNow, track: null, playing: true, emptyText });
  },
  load: () => import("./view"),
  editor: () => import("./editor"),
};
