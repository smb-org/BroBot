import { z } from "zod";

import type { BotModule } from "../contract";
import { textLibraryModuleCatalog } from "./catalog";
import { textLibraryRoutes } from "./routes";
import { createTextBlockTemplateExpander } from "./adapters/template-expander";

const settingsSchema = z.object({});

export const textLibraryModule: BotModule<typeof settingsSchema> = {
  id: "text_library",
  mandatory: true,
  mandatoryReason: {
    de: textLibraryModuleCatalog.de.mandatoryReason,
    en: textLibraryModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  navigationEntries: [{
    id: "texts",
    label: { de: textLibraryModuleCatalog.de.label, en: textLibraryModuleCatalog.en.label },
    description: { de: textLibraryModuleCatalog.de.description, en: textLibraryModuleCatalog.en.description },
    iconKind: "texts",
    keywords: ["text", "texts", "texte", "textbausteine", "library", "bibliothek"],
  }],
  expandTemplateVariables: (context) => createTextBlockTemplateExpander(context.DB, context.channelId, {
    templateContext: context.templateContext,
    chatStatus: context.chatStatus,
    streamState: context.streamState,
    currentGame: async () => {
      const channel = await context.channelInfo();
      return channel === null || channel.gameId.length === 0 ? null : { id: channel.gameId, name: channel.gameName };
    },
    now: context.now,
  })(context.text, context.knownVariables),
  routes: textLibraryRoutes,
  panel: () => import("./panel/index"),
};

export { TEXT_BLOCK_MAXIMUMS } from "./contracts";
export type { TextBlock, TextBlockCategory, TextBlockConditions, TextBlockVariant, TwitchGame } from "./contracts";
export { firstMatchingTextBlockVariant, textBlockConditionsMatch, validateTextBlockGraph } from "./domain";
