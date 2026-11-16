import { ADS_COUNTDOWN_ELEMENT_KIND } from "./kinds";
import { adsCountdownLabels } from "./countdown-locale";
import type { JsonObject, ModuleLanguage, ModuleOverlayAppearanceDefinition } from "../../contract";
import { parseOverlayElementConfig } from "../../../overlay/appearance";

const editorLabels = { de: adsCountdownLabels("de"), en: adsCountdownLabels("en") };
const appearance = {
  parts: ["background", "text"],
  defaults: { background: "transparent", text: "rgba(255, 255, 255, 0.96)" },
} satisfies ModuleOverlayAppearanceDefinition;

const adsCountdownElement = {
  kind: ADS_COUNTDOWN_ELEMENT_KIND,
  configVersion: 3,
  appearance,
  defaultSize: { width: 300, height: 96 },
  defaultConfig: { showSnoozeInfo: false, appearance: appearance.defaults },
  previewState: (_config: JsonObject, _language: ModuleLanguage, now: number): JsonObject => ({
    nextAdAt: new Date(now + 150_000).toISOString(),
    duration: 180,
    snoozeCount: 2,
    snoozeRefreshAt: null,
    serverNow: new Date(now).toISOString(),
    isSample: true,
  }),
  editorLabel: { de: editorLabels.de.editorLabel, en: editorLabels.en.editorLabel },
  editorDescription: { de: editorLabels.de.editorDescription, en: editorLabels.en.editorDescription },
  editorModuleLabel: { de: editorLabels.de.editorModuleLabel, en: editorLabels.en.editorModuleLabel },
  parseConfig: (raw: unknown) => parseOverlayElementConfig(raw, appearance, (config) => {
    if (Object.keys(config).some((key) => key !== "showSnoozeInfo")) return null;
    const showSnoozeInfo = config.showSnoozeInfo;
    if (showSnoozeInfo !== undefined && typeof showSnoozeInfo !== "boolean") return null;
    return { showSnoozeInfo: showSnoozeInfo === true };
  }),
  load: () => import("./countdown"),
  editor: () => import("./countdown-editor"),
};

// This client-safe declaration is shared with the dashboard and overlay
// registries. Server-only initial state is added by the ads module itself.
export const adsOverlayElements = [{
  ...adsCountdownElement,
  kind: ADS_COUNTDOWN_ELEMENT_KIND as `${string}.${string}`,
}];
