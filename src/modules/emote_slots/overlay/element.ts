import type { JsonObject, ModuleLanguage } from "../../contract";
import { DEFAULT_SLOT_OVERLAY_CONFIG, mergeSlotOverlayRealtimeState, parseSlotOverlayConfig } from "./state";
import { emoteSlotOverlayLabels } from "./locale";
import { EMOTE_SLOT_OVERLAY_ELEMENT_KIND } from "./kinds";

const german = emoteSlotOverlayLabels("de");
const english = emoteSlotOverlayLabels("en");

export const emoteSlotOverlayElement = {
  kind: EMOTE_SLOT_OVERLAY_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 640, height: 160 },
  defaultConfig: DEFAULT_SLOT_OVERLAY_CONFIG,
  hideWhenModuleDisabled: true,
  previewState: (_config: JsonObject, language: ModuleLanguage, now: number): JsonObject => ({
    spinId: "overlay-editor-preview",
    login: "pixelwanderer",
    language,
    outcome: "win",
    spunAt: new Date(now).toISOString(),
    symbols: [
      { source: "emoji", code: "🍒" },
      { source: "emoji", code: "🔔" },
      { source: "emoji", code: "🍒" },
    ],
    net: 70,
    jackpot: 1_256,
    jackpotHit: false,
  }),
  editorLabel: { de: german.elementLabel, en: english.elementLabel },
  editorDescription: { de: german.editorDescription, en: english.editorDescription },
  editorModuleLabel: { de: german.elementLabel, en: english.elementLabel },
  mergeRealtimeStateOnModuleMessages: ["modul.emote_slots.spin"],
  mergeRealtimeState: mergeSlotOverlayRealtimeState,
  parseConfig: (raw: unknown) => parseSlotOverlayConfig(raw),
  load: () => import("./slot"),
  editor: () => import("./editor"),
} as const;

export const emoteSlotOverlayElements = [emoteSlotOverlayElement] as const;
