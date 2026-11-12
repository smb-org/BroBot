import type { JsonObject, ModuleOverlayElementDefinition } from "../../contract";
import { overlayAlertElementTexts } from "./locale";
import { DEFAULT_OVERLAY_ALERT_CONFIG, emptyOverlayAlertQueueState, parseOverlayAlertConfig, parseOverlayAlertQueueState, overlayAlertStateForBootstrap } from "./state";

const previewState = (_config: JsonObject, language: "de" | "en", now: number): JsonObject => {
  const state = emptyOverlayAlertQueueState(now);
  const startedAt = new Date(now).toISOString();
  return {
    ...state,
    current: {
      operationId: "overlay-editor-preview",
      text: language === "de" ? "Viewer Name · Community-Wunsch" : "Viewer Name · Community request",
      durationSeconds: 5,
      volumePercent: 80,
      startedAt,
      endsAt: new Date(now + 5_000).toISOString(),
    },
  } as unknown as JsonObject;
};

export const overlayAlertElement: ModuleOverlayElementDefinition = {
  kind: "overlay_alerts.alert",
  configVersion: 1,
  defaultSize: { width: 640, height: 220 },
  defaultConfig: DEFAULT_OVERLAY_ALERT_CONFIG as unknown as JsonObject,
  previewState,
  editorLabel: {
    de: overlayAlertElementTexts.de.name,
    en: overlayAlertElementTexts.en.name,
  },
  editorAddLabel: {
    de: overlayAlertElementTexts.de.name,
    en: overlayAlertElementTexts.en.name,
  },
  editorDescription: {
    de: overlayAlertElementTexts.de.description,
    en: overlayAlertElementTexts.en.description,
  },
  initialStateNeedsSnapshotContext: true,
  reloadStateOnModuleMessages: ["modul.overlay_alerts.state_changed"],
  parseConfig: (raw) => {
    const parsed = parseOverlayAlertConfig(raw);
    return parsed === null ? null : parsed as unknown as JsonObject;
  },
  initialStateFromSnapshot: async (_db, _channelId, _config, context) => {
    const state = parseOverlayAlertQueueState(await context.readSnapshot());
    return (state === null
      ? emptyOverlayAlertQueueState(context.now)
      : overlayAlertStateForBootstrap(state, context.now)) as unknown as JsonObject;
  },
  load: () => import("./view"),
  editor: () => import("./editor"),
};
