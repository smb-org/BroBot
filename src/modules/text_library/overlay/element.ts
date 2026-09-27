import { TEXT_BLOCK_NAME_PATTERN } from "../contracts";
import { textBlockOverlayEditorTexts } from "./locale";

const editorTexts = textBlockOverlayEditorTexts;

export const TEXT_BLOCK_OVERLAY_ELEMENT_KIND = "text_library.block" as const;

export const textBlockOverlayElement = {
  kind: TEXT_BLOCK_OVERLAY_ELEMENT_KIND,
  configVersion: 1,
  defaultSize: { width: 360, height: 96 },
  defaultConfig: { blockName: "" },
  editorLabel: { de: editorTexts.de.label, en: editorTexts.en.label },
  editorAddLabel: { de: editorTexts.de.addLabel, en: editorTexts.en.addLabel },
  editorModuleLabel: { de: editorTexts.de.moduleLabel, en: editorTexts.en.moduleLabel },
  initialStateNeedsContext: true,
  reloadStateOnModuleMessages: ["modul.text_library.blocks_updated"] as const,
  reloadStateOnHostEvents: ["channel.game.changed", "stream.state.changed"] as const,
  parseConfig: (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const config = raw as Record<string, unknown>;
    if (Object.keys(config).some((key) => key !== "blockName")) return null;
    const blockName = config.blockName;
    return typeof blockName === "string" && (blockName.length === 0 || TEXT_BLOCK_NAME_PATTERN.test(blockName))
      ? { blockName }
      : null;
  },
  load: () => import("./view"),
  editor: () => import("./editor"),
};
