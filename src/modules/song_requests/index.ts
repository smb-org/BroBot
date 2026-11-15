import { z } from "zod";
import { PanelApiError } from "../../contracts/panel-error";
import type { BotModule } from "../contract";
import {
  processSongRequestsEvent,
  pollSongRequestsPlayback,
  handleSongRequestDurableAction,
  handleSongRequestsLifecycleAlarm,
  handleSubmitAlarm,
  readSpotifyAccessTokenAlarm,
  SONG_REQUESTS_ACCESS_TOKEN_HANDLER,
  SONG_REQUESTS_ALARM,
  SONG_REQUESTS_LIFECYCLE_HANDLER,
  SONG_REQUESTS_SUBMIT_HANDLER,
} from "./service";
import { songRequestsRoutes } from "./routes";
import { songRequestsNowPlayingElement } from "./overlay/element";
import { songRequestsActionTexts } from "./panel/action-locale";

const settingsSchema = z.object({ emptyText: z.string().max(80).default("") });

export const songRequestsModule: BotModule<typeof settingsSchema> = {
  id: "song_requests",
  requiresModules: ["chat_voting"],
  navigationCategory: "stream",
  settingsSchema,
  defaultSettings: settingsSchema.parse({}),
  defaultEnabled: false,
  panelManagesSettings: true,
  panelIcon: { paths: ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"] },
  eventSubTypes: ["stream.online", "stream.offline"],
  pauseSafeEventSubTypes: ["stream.online", "stream.offline"],
  handleEvent: processSongRequestsEvent,
  routes: songRequestsRoutes,
  overlayElements: [songRequestsNowPlayingElement],
  panel: () => import("./panel"),
  actions: [{
    id: "start-song-vote",
    name: { de: songRequestsActionTexts.de.name, en: songRequestsActionTexts.en.name },
    icon: "vote",
    conditions: ["moduleEnabled", "streamLive"],
    requiredRole: "operator",
    content: { presentation: "dialog", requiresReadiness: true, hideSubmit: true, dismissAsClose: true, load: () => import("./panel/cockpit-action-content") },
    errorMessage: { de: songRequestsActionTexts.de.error, en: songRequestsActionTexts.en.error },
    execute: async ({ channelId, formData }) => {
      const trackIds = formData.getAll("trackId").filter((id): id is string => typeof id === "string");
      try {
        await (await import("../../dashboard/api")).startSongRequestVote(channelId, trackIds);
        return { tone: "success", message: { de: songRequestsActionTexts.de.started, en: songRequestsActionTexts.en.started } };
      } catch (error) {
        if (error instanceof PanelApiError && error.code === "chat_vote_already_open") {
          return { tone: "error", message: { de: songRequestsActionTexts.de.busy, en: songRequestsActionTexts.en.busy } };
        }
        return { tone: "error", message: { de: songRequestsActionTexts.de.error, en: songRequestsActionTexts.en.error } };
      }
    },
  }],
  alarms: [
    { key: SONG_REQUESTS_ALARM, retryDelaysMs: [12_000, 24_000, 48_000, 96_000], handle: pollSongRequestsPlayback },
    { key: SONG_REQUESTS_SUBMIT_HANDLER, retryDelaysMs: [5_000, 15_000, 60_000], handle: handleSubmitAlarm },
    { key: SONG_REQUESTS_LIFECYCLE_HANDLER, handle: handleSongRequestsLifecycleAlarm },
    { key: SONG_REQUESTS_ACCESS_TOKEN_HANDLER, handle: async (context) => await readSpotifyAccessTokenAlarm(context) },
  ],
  handleDurableAction: handleSongRequestDurableAction,
  onActivationChange: async (activation, _channelId, enabled) => {
    await activation.runModuleAlarm(SONG_REQUESTS_LIFECYCLE_HANDLER, "activation", { enabled });
  },
};
