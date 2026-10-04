import { CHAT_VOTING_TALLY_ELEMENT_KIND } from "./kinds";
import { chatVotingOverlayLabels } from "./locale";

const german = chatVotingOverlayLabels("de");
const english = chatVotingOverlayLabels("en");

export const chatVotingOverlayElement = {
  kind: CHAT_VOTING_TALLY_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 640, height: 240 },
  defaultConfig: { layout: "bars", showPercent: true, hideAfterCloseSeconds: 15 },
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorAddLabel: { de: german.editorAddLabel, en: english.editorAddLabel },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  reloadStateOnModuleMessages: ["modul.chat_voting.opened", "modul.chat_voting.closed"],
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    if (Object.keys(config).some((key) => !["layout", "showPercent", "hideAfterCloseSeconds"].includes(key))) return null;
    const layout = config.layout ?? "bars";
    const showPercent = config.showPercent ?? true;
    const hideAfterCloseSeconds = config.hideAfterCloseSeconds ?? 15;
    if ((layout !== "strip" && layout !== "bars") || typeof showPercent !== "boolean" ||
        typeof hideAfterCloseSeconds !== "number" || !Number.isSafeInteger(hideAfterCloseSeconds) ||
        hideAfterCloseSeconds < 0 || hideAfterCloseSeconds > 120) return null;
    return { layout, showPercent, hideAfterCloseSeconds };
  },
  load: () => import("./tally"),
  editor: () => import("./editor"),
};

export const chatVotingOverlayElements = [chatVotingOverlayElement] as const;
