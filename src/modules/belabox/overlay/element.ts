import type { JsonObject, ModuleOverlayElementDefinition } from "../../contract";
import { BELABOX_STATUS_ELEMENT_KIND } from "./kinds";
import { belaboxOverlayLabels } from "./locale";
import { mergeBelaboxRealtimeState } from "./state";

const german = belaboxOverlayLabels("de");
const english = belaboxOverlayLabels("en");

export const belaboxStatusOverlayElement: ModuleOverlayElementDefinition = {
  kind: BELABOX_STATUS_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 320, height: 64 },
  defaultConfig: { layout: "compact", unit: "kbps", hideWhenHealthy: false },
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
  }),
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorAddLabel: { de: german.editorAddLabel, en: english.editorAddLabel },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  mergeRealtimeStateOnModuleMessages: ["modul.belabox.sample"],
  mergeRealtimeState: mergeBelaboxRealtimeState,
  reloadStateOnHostEvents: ["stream.state.changed"],
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Readonly<Record<string, unknown>>;
    if (Object.keys(config).some((key) => !["layout", "unit", "hideWhenHealthy"].includes(key))) return null;
    const layout = config.layout ?? "compact";
    const unit = config.unit ?? "kbps";
    const hideWhenHealthy = config.hideWhenHealthy ?? false;
    if ((layout !== "compact" && layout !== "detail") || (unit !== "kbps" && unit !== "mbps") ||
        typeof hideWhenHealthy !== "boolean") return null;
    return { layout, unit, hideWhenHealthy };
  },
  load: () => import("./status"),
  editor: () => import("./editor"),
};

export const belaboxOverlayElements = [belaboxStatusOverlayElement] as const;
