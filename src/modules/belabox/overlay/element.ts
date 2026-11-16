import type { JsonObject, ModuleOverlayAppearanceDefinition, ModuleOverlayElementDefinition } from "../../contract";
import { parseOverlayElementConfig } from "../../../overlay/appearance";
import { BELABOX_STATUS_ELEMENT_KIND } from "./kinds";
import { belaboxOverlayLabels } from "./locale";
import { mergeBelaboxRealtimeState } from "./state";

const german = belaboxOverlayLabels("de");
const english = belaboxOverlayLabels("en");
const appearance = {
  parts: ["background", "text"],
  defaults: { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
} satisfies ModuleOverlayAppearanceDefinition;

const belaboxStatusOverlayElement: ModuleOverlayElementDefinition = {
  kind: BELABOX_STATUS_ELEMENT_KIND,
  configVersion: 2,
  appearance,
  defaultSize: { width: 320, height: 40 },
  defaultConfig: { layout: "compact", unit: "kbps", hideWhenHealthy: false, appearance: appearance.defaults },
  previewState: (_config: JsonObject, _language, now): JsonObject => ({
    sample: {
      at: new Date(now).toISOString(),
      connected: true,
      bitrateKbps: 4_520,
      rttMs: 38,
      phase: "healthy",
    },
    intervalSeconds: 15,
    mode: "interval",
    streamSessionKey: null,
  }),
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorAddLabel: { de: german.editorAddLabel, en: english.editorAddLabel },
  editorDescription: { de: german.editorDescription, en: english.editorDescription },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  mergeRealtimeStateOnModuleMessages: ["modul.belabox.sample"],
  mergeRealtimeState: mergeBelaboxRealtimeState,
  reloadStateOnHostEvents: ["stream.state.changed"],
  parseConfig: (raw: unknown) => parseOverlayElementConfig(raw, appearance, (config) => {
    if (Object.keys(config).some((key) => !["layout", "unit", "hideWhenHealthy"].includes(key))) return null;
    const layout = config.layout ?? "compact";
    const unit = config.unit ?? "kbps";
    const hideWhenHealthy = config.hideWhenHealthy ?? false;
    if ((layout !== "compact" && layout !== "detail") || (unit !== "kbps" && unit !== "mbps") ||
        typeof hideWhenHealthy !== "boolean") return null;
    return { layout, unit, hideWhenHealthy };
  }),
  load: () => import("./status"),
  editor: () => import("./editor"),
};

export const belaboxOverlayElements = [belaboxStatusOverlayElement] as const;
