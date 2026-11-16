import { TEXT_BLOCK_NAME_PATTERN } from "../contracts";
import { textBlockOverlayEditorTexts } from "./locale";
import { previewStateFor } from "./preview-state";
import type { JsonObject, ModuleLanguage, ModuleOverlayAppearanceDefinition } from "../../contract";
import { parseOverlayElementConfig } from "../../../overlay/appearance";

const editorTexts = textBlockOverlayEditorTexts;

export const TEXT_BLOCK_OVERLAY_ELEMENT_KIND = "text_library.block" as const;
const appearance = {
  parts: ["background", "text", "secondaryText"],
  defaults: { background: "transparent", text: "rgba(255, 255, 255, 0.96)", secondaryText: "rgba(255, 255, 255, 0.78)" },
} satisfies ModuleOverlayAppearanceDefinition;

export const textBlockOverlayElement = {
  kind: TEXT_BLOCK_OVERLAY_ELEMENT_KIND,
  configVersion: 2,
  appearance,
  defaultSize: { width: 360, height: 96 },
  defaultConfig: { blockName: "", appearance: appearance.defaults },
  previewState: (config: JsonObject, language: ModuleLanguage, now: number): JsonObject => {
    const blockName = typeof config.blockName === "string" ? config.blockName : "";
    const labels = textBlockOverlayEditorTexts[language];
    return previewStateFor(blockName.length === 0 ? labels.previewPlaceholder : blockName, labels.sampleValues, now);
  },
  editorLabel: { de: editorTexts.de.label, en: editorTexts.en.label },
  editorDescription: { de: editorTexts.de.description, en: editorTexts.en.description },
  editorModuleLabel: { de: editorTexts.de.moduleLabel, en: editorTexts.en.moduleLabel },
  initialStateNeedsContext: true,
  reloadStateOnModuleMessages: ["modul.text_library.blocks_updated"] as const,
  reloadStateOnHostEvents: ["channel.game.changed", "stream.state.changed", "template.data.changed"] as const,
  parseConfig: (raw: unknown) => parseOverlayElementConfig(raw, appearance, (config) => {
    if (Object.keys(config).some((key) => key !== "blockName")) return null;
    const blockName = config.blockName;
    return typeof blockName === "string" && (blockName.length === 0 || TEXT_BLOCK_NAME_PATTERN.test(blockName))
      ? { blockName }
      : null;
  }),
  load: () => import("./view"),
  editor: () => import("./editor"),
};
