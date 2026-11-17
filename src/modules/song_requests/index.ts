import { PanelApiError } from "../../contracts/panel-error";
import type { BotModule, ModuleImmediateActionCondition } from "../contract";
import { songRequestsSettingsForLanguage, songRequestsSettingsSchema } from "./contracts";
import { SONG_REQUEST_TEMPLATE_FIELDS, SONG_REQUEST_TEMPLATE_VARIABLES, songRequestTemplateVariableGroup } from "./contracts/template-variables";
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
import { songRequestsQueueElement } from "./overlay/queue-element";
import { songRequestsActionTexts } from "./panel/action-locale";
import { songRequestsPanelTexts } from "./panel/locale";
import { songRequestQueueSubtitle } from "./panel/queue-action-locale";
import { requestSongChannelPointsAction } from "./channel-points-action";

const queueAvailability: ModuleImmediateActionCondition = {
  query: {
    moduleId: "song_requests",
    part: "action-availability-queue",
    load: async (channelId, signal) => {
      const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/song_requests/queue`, { signal });
      if (!response.ok) throw new Error("Song request queue could not be loaded.");
      return await response.json();
    },
    evaluate: (value) => {
      const response = typeof value === "object" && value !== null ? value as { count?: unknown } : null;
      const count = typeof response?.count === "number" && Number.isSafeInteger(response.count) ? response.count : 0;
      return {
        reason: null,
        visible: count > 0,
        ...(count === 0 ? {} : { subtitle: {
          de: songRequestQueueSubtitle.de(count),
          en: songRequestQueueSubtitle.en(count),
        } }),
      };
    },
  },
};

export const songRequestsModule: BotModule<typeof songRequestsSettingsSchema> = {
  id: "song_requests",
  requiresModules: ["chat_voting"],
  navigationCategory: "stream",
  navigationEntries: [
    {
      id: "requests",
      label: { de: songRequestsPanelTexts.de.navigation.requests.label, en: songRequestsPanelTexts.en.navigation.requests.label },
      description: { de: songRequestsPanelTexts.de.navigation.requests.description, en: songRequestsPanelTexts.en.navigation.requests.description },
      iconKind: "music",
      keywords: ["songs", "song requests", "spotify", "queue"],
    },
    {
      id: "settings",
      label: { de: songRequestsPanelTexts.de.navigation.settings.label, en: songRequestsPanelTexts.en.navigation.settings.label },
      description: { de: songRequestsPanelTexts.de.navigation.settings.description, en: songRequestsPanelTexts.en.navigation.settings.description },
      iconKind: "system",
      keywords: ["settings", "payment", "rules"],
    },
  ],
  settingsSchema: songRequestsSettingsSchema,
  defaultSettings: songRequestsSettingsForLanguage("de"),
  defaultSettingsForLanguage: songRequestsSettingsForLanguage,
  defaultEnabled: false,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorPlacement: "page",
  settingsEditorPageId: "settings",
  templateFields: SONG_REQUEST_TEMPLATE_FIELDS,
  templateContext: "event",
  templateVariableCatalog: SONG_REQUEST_TEMPLATE_VARIABLES,
  templateVariableGroup: songRequestTemplateVariableGroup,
  channelPointsActions: [requestSongChannelPointsAction],
  settingsChangedAlarm: { handlerKey: SONG_REQUESTS_LIFECYCLE_HANDLER, alarmKey: "settings" },
  chatCommands: [{
    name: "!sr",
    syntax: "!sr <song or Spotify link>",
    syntaxByLanguage: { de: "!sr <Song oder Spotify-Link>", en: "!sr <song or Spotify link>" },
    description: { de: "Fordere einen Song mit Punkten oder kostenlos an.", en: "Request a song with points or for free." },
    arguments: [{
      name: "song or link",
      nameByLanguage: { de: "Song oder Link", en: "song or link" },
      hint: { de: "Songtitel, Spotify-Link oder URI", en: "Track title, Spotify link, or URI" },
    }],
    minimumChatStatus: "configurable",
    minimumChatStatusSetting: "freeRoleThreshold",
  }, {
    name: "!skip",
    syntax: "!skip",
    description: { de: songRequestsActionTexts.de.skipCommandDescription, en: songRequestsActionTexts.en.skipCommandDescription },
    minimumChatStatus: "everyone",
  }],
  panelIcon: { paths: ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"] },
  eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline"],
  pauseSafeEventSubTypes: ["stream.online", "stream.offline"],
  handleEvent: processSongRequestsEvent,
  // `!sr` charges points and queues in Spotify, so a single message cannot be simulated read-only.
  dryRunSilentReason: "instant_settlement",
  routes: songRequestsRoutes,
  statisticsSections: [{
    id: "song-request-statistics",
    title: { de: songRequestsActionTexts.de.statisticsTitle, en: songRequestsActionTexts.en.statisticsTitle },
    load: () => import("./panel/statistics-section"),
  }],
  overlayElements: [songRequestsNowPlayingElement, songRequestsQueueElement],
  panel: () => import("./panel"),
  actions: [{
    id: "start-song-vote",
    name: { de: songRequestsActionTexts.de.name, en: songRequestsActionTexts.en.name },
    icon: "vote",
    conditions: ["moduleEnabled"],
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
  }, {
    id: "skip-song",
    name: { de: songRequestsActionTexts.de.skipName, en: songRequestsActionTexts.en.skipName },
    icon: "skip-forward",
    conditions: ["moduleEnabled"],
    requiredRole: "operator",
    errorMessage: { de: songRequestsActionTexts.de.skipUnavailable, en: songRequestsActionTexts.en.skipUnavailable },
    execute: async ({ channelId }) => {
      try {
        const outcome = await (await import("./panel/service")).skipSong(channelId);
        if (outcome === "skipped") {
          return { tone: "success", message: { de: songRequestsActionTexts.de.skipSucceeded, en: songRequestsActionTexts.en.skipSucceeded } };
        }
        if (outcome === "no_active_device") {
          return { tone: "error", message: { de: songRequestsActionTexts.de.skipDevice, en: songRequestsActionTexts.en.skipDevice } };
        }
        return { tone: "error", message: { de: songRequestsActionTexts.de.skipUnavailable, en: songRequestsActionTexts.en.skipUnavailable } };
      } catch {
        return { tone: "error", message: { de: songRequestsActionTexts.de.skipUnavailable, en: songRequestsActionTexts.en.skipUnavailable } };
      }
    },
  }, {
    id: "song-request-queue",
    name: { de: songRequestsActionTexts.de.queueName, en: songRequestsActionTexts.en.queueName },
    icon: "queue",
    conditions: ["moduleEnabled", queueAvailability],
    requiredRole: "operator",
    hideUntilAvailable: true,
    content: { presentation: "dialog", hideSubmit: true, dismissAsClose: true, load: () => import("./panel/queue-action-content") },
    execute: () => Promise.resolve(),
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
