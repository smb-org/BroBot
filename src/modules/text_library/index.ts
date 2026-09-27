import { z } from "zod";

import type { BotModule } from "../contract";
import { textLibraryModuleCatalog } from "./catalog";
import { textLibraryRoutes } from "./routes";
import { createTextBlockTemplateValueProvider } from "./adapters/template-expander";

const settingsSchema = z.object({});

export const textLibraryModule: BotModule<typeof settingsSchema> = {
  id: "text_library",
  panelIcon: { paths: ["M5 5h14v14H5z", "M8 9h8", "M8 12h8", "M8 15h5"] },
  mandatory: true,
  mandatoryReason: {
    de: textLibraryModuleCatalog.de.mandatoryReason,
    en: textLibraryModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateVariables: async (db, channelId) => {
    const result = await db.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ? ORDER BY block_name")
      .bind(channelId).all<{ block_name: string }>();
    return result.results.map(({ block_name }) => ({ name: block_name, sample: "", maxLength: 500 }));
  },
  navigationEntries: [{
    id: "texts",
    label: { de: textLibraryModuleCatalog.de.label, en: textLibraryModuleCatalog.en.label },
    description: { de: textLibraryModuleCatalog.de.description, en: textLibraryModuleCatalog.en.description },
    group: "channel",
    showMainSwitch: false,
    iconKind: "texts",
    keywords: ["text", "texts", "texte", "textbausteine", "library", "bibliothek"],
  }],
  templateVariableNamespace: "text_blocks",
  templateValueOutputLimit: 500,
  resolveTemplateValues: (names, context) =>
    createTextBlockTemplateValueProvider(context.DB, context.channelId)(names, context),
  routes: textLibraryRoutes,
  panel: () => import("./panel/index"),
};

export { TEXT_BLOCK_MAXIMUMS } from "./contracts";
export type { TextBlock, TextBlockCategory, TextBlockConditions, TextBlockVariant, TwitchGame } from "./contracts";
export { firstMatchingTextBlockVariant, textBlockConditionsMatch, validateTextBlockGraph } from "./domain";
