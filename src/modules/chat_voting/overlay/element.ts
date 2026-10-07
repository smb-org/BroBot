import { CHAT_VOTING_TALLY_ELEMENT_KIND } from "./kinds";
import { chatVotingOverlayLabels } from "./locale";
import { mergeTallyRealtimeState } from "./tally-state";
import type { JsonObject, ModuleLanguage } from "../../contract";

const german = chatVotingOverlayLabels("de");
const english = chatVotingOverlayLabels("en");

export const chatVotingOverlayElement = {
  kind: CHAT_VOTING_TALLY_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 480, height: 240 },
  defaultConfig: { layout: "bars", showPercent: true, showCountdown: true, hideAfterCloseSeconds: 15, width: 480 },
  previewState: (_config: JsonObject, language: ModuleLanguage, now: number): JsonObject => ({
    pollId: "overlay-editor-preview",
    openedAt: new Date(now).toISOString(),
    closesAt: new Date(now + 120_000).toISOString(),
    requestedDurationSeconds: 120,
    serverNow: new Date(now).toISOString(),
    serverTimeOffsetMs: 0,
    serverTimeLocalNowMs: now,
    title: chatVotingOverlayLabels(language).previewTitle,
    status: "open",
    preset: "free_text",
    optionCount: 0,
    textMode: "first_word",
    labels: chatVotingOverlayLabels(language).previewOptions,
    counts: [],
    terms: [
      { term: "preview", count: 12, approved: true },
      { term: "?", count: 7, approved: false },
      { term: "sample", count: 3, approved: true },
    ],
    more: 1,
    termFilterReady: true,
    revision: 1,
  }),
  editorLabel: { de: german.editorLabel, en: english.editorLabel },
  editorDescription: { de: german.editorDescription, en: english.editorDescription },
  editorModuleLabel: { de: german.editorModuleLabel, en: english.editorModuleLabel },
  reloadStateOnModuleMessages: ["modul.chat_voting.opened"],
  mergeRealtimeState: mergeTallyRealtimeState,
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    if (Object.keys(config).some((key) => !["layout", "showPercent", "showCountdown", "hideAfterCloseSeconds", "width"].includes(key))) return null;
    const layout = config.layout ?? "bars";
    const showPercent = config.showPercent ?? true;
    const showCountdown = config.showCountdown ?? true;
    const hideAfterCloseSeconds = config.hideAfterCloseSeconds ?? 15;
    const width = config.width ?? 480;
    if (typeof width !== "number" || !Number.isSafeInteger(width) || width < 200 || width > 1920) return null;
    if ((layout !== "strip" && layout !== "bars") || typeof showPercent !== "boolean" || typeof showCountdown !== "boolean" ||
        typeof hideAfterCloseSeconds !== "number" || !Number.isSafeInteger(hideAfterCloseSeconds) ||
        hideAfterCloseSeconds < 0 || hideAfterCloseSeconds > 120) return null;
    return { layout, showPercent, showCountdown, hideAfterCloseSeconds, width };
  },
  load: () => import("./tally"),
  editor: () => import("./editor"),
};

export const chatVotingOverlayElements = [chatVotingOverlayElement] as const;
