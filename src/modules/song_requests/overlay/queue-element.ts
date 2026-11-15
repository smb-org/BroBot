import type { ModuleOverlayElementDefinition } from "../../contract";
import { buildSongRequestQueueState } from "../domain/queue-state";
import { songRequestQueueTexts } from "./queue-locale";
import { SONG_REQUESTS_QUEUE_KIND, SONG_REQUESTS_QUEUE_SIZE } from "./kinds";
import { mergeSongRequestQueueState, parseSongRequestQueueConfig, readSongRequestQueueState, songRequestQueueStateJson } from "./queue-state";

export const songRequestsQueueElement: ModuleOverlayElementDefinition = {
  kind: SONG_REQUESTS_QUEUE_KIND,
  configVersion: 1,
  defaultSize: SONG_REQUESTS_QUEUE_SIZE,
  defaultConfig: {},
  previewState: () => songRequestQueueStateJson(buildSongRequestQueueState({
    revision: 1,
    rowCount: 10,
    rows: [
      { title: "Glass Harbor", requester: "mira_viewer", requestType: "bot_points" },
      { title: "After the Rain", requester: "skyline_fan", requestType: "free" },
    ],
  })),
  editorLabel: { de: songRequestQueueTexts.de.name, en: songRequestQueueTexts.en.name },
  editorAddLabel: { de: songRequestQueueTexts.de.name, en: songRequestQueueTexts.en.name },
  editorDescription: { de: songRequestQueueTexts.de.description, en: songRequestQueueTexts.en.description },
  editorModuleLabel: { de: songRequestQueueTexts.de.moduleLabel, en: songRequestQueueTexts.en.moduleLabel },
  initialStateNeedsContext: true,
  reloadStateOnModuleMessages: ["modul.song_requests.queue_changed"],
  mergeRealtimeStateOnModuleMessages: ["modul.song_requests.queue_changed"],
  mergeRealtimeState: mergeSongRequestQueueState,
  parseConfig: parseSongRequestQueueConfig,
  initialState: async (db, channelId) => await readSongRequestQueueState(db, channelId),
  load: () => import("./queue-view"),
};
