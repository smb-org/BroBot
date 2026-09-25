import { ADS_COUNTDOWN_ELEMENT_KIND } from "./kinds";

export const adsCountdownElement = {
  kind: ADS_COUNTDOWN_ELEMENT_KIND,
  configVersion: 2,
  defaultSize: { width: 300, height: 96 },
  defaultConfig: { showSnoozeInfo: false },
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
