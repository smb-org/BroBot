import type { JsonObject, ModuleLanguage } from "../../contract";
import { mergeVotekickRealtimeState } from "./state";
import { votekickOverlayLabels } from "./locale";
import { VOTEKICK_ELEMENT_KIND } from "./kinds";

const german = votekickOverlayLabels("de");
const english = votekickOverlayLabels("en");

export const votekickOverlayElement = {
  kind: VOTEKICK_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 480, height: 160 },
  defaultConfig: { showCountdown: true, hideAfterCloseSeconds: 15 },
  previewState: (_config: JsonObject, _language: ModuleLanguage, now: number): JsonObject => ({
    votekickId: "overlay-editor-preview",
    targetLogin: "sampleviewer",
    targetUserId: "preview-target",
    yesVotes: 4,
    noVotes: 1,
    threshold: 5,
    ballotRevision: 5,
    status: "running",
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + 120_000).toISOString(),
    endedAt: null,
  }),
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorDescription: { de: german.editorDescription, en: english.editorDescription },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  reloadStateOnModuleMessages: ["modul.votekick.opened"],
  mergeRealtimeStateOnModuleMessages: ["modul.votekick.tally"],
  mergeRealtimeState: mergeVotekickRealtimeState,
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    if (Object.keys(config).some((key) => !["showCountdown", "hideAfterCloseSeconds"].includes(key))) return null;
    const showCountdown = config.showCountdown ?? true;
    const hideAfterCloseSeconds = config.hideAfterCloseSeconds ?? 15;
    if (typeof showCountdown !== "boolean" || typeof hideAfterCloseSeconds !== "number" ||
        !Number.isSafeInteger(hideAfterCloseSeconds) || hideAfterCloseSeconds < 0 || hideAfterCloseSeconds > 120) return null;
    return { showCountdown, hideAfterCloseSeconds };
  },
  load: () => import("./tally"),
  editor: () => import("./editor"),
};

export const votekickOverlayElements = [votekickOverlayElement] as const;
