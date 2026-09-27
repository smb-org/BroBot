import { ADS_COUNTDOWN_ELEMENT_KIND } from "./kinds";
import { adsCountdownLabels } from "./countdown-locale";

const editorLabels = { de: adsCountdownLabels("de"), en: adsCountdownLabels("en") };

export const adsCountdownElement = {
  kind: ADS_COUNTDOWN_ELEMENT_KIND,
  configVersion: 2,
  defaultSize: { width: 300, height: 96 },
  defaultConfig: { showSnoozeInfo: false },
  editorLabel: { de: editorLabels.de.editorLabel, en: editorLabels.en.editorLabel },
  editorAddLabel: { de: editorLabels.de.editorAddLabel, en: editorLabels.en.editorAddLabel },
  editorModuleLabel: { de: editorLabels.de.editorModuleLabel, en: editorLabels.en.editorModuleLabel },
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    const keys = Object.keys(config);
    if (keys.some((key) => key !== "showSnoozeInfo")) return null;
    const showSnoozeInfo = config.showSnoozeInfo;
    if (showSnoozeInfo !== undefined && typeof showSnoozeInfo !== "boolean") return null;
    return { showSnoozeInfo: showSnoozeInfo === true };
  },
  load: () => import("./countdown"),
  editor: () => import("./countdown-editor"),
};

// This client-safe declaration is shared with the dashboard and overlay
// registries. Server-only initial state is added by the ads module itself.
export const adsOverlayElements = [{
  ...adsCountdownElement,
  kind: ADS_COUNTDOWN_ELEMENT_KIND as `${string}.${string}`,
}];
