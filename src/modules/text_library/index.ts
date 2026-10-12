import { z } from "zod";

import type { BotModule } from "../contract";
import { textLibraryModuleCatalog } from "./catalog";
import { textLibraryRoutes } from "./routes";
import { createTextBlockTemplateValueProvider } from "./adapters/template-expander";
import { textBlockOverlayElement, TEXT_BLOCK_OVERLAY_ELEMENT_KIND } from "./overlay/element";
import { textBlockOverlayState } from "./overlay/state";

const settingsSchema = z.object({});

export const textLibraryModule: BotModule<typeof settingsSchema> = {
  id: "text_library",
  navigationCategory: "chat",
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
    const result = await db.prepare(
      `SELECT block.block_name,
              (SELECT json_extract(variant.texts_json, '$[0]')
                 FROM text_block_variants AS variant
                WHERE variant.channel_id = block.channel_id AND variant.block_name = block.block_name
                ORDER BY variant.position LIMIT 1) AS sample
         FROM text_blocks AS block WHERE block.channel_id = ? ORDER BY block.block_name`,
    ).bind(channelId).all<{ block_name: string; sample: string | null }>();
    return result.results.map(({ block_name, sample }) => ({ name: `text.${block_name}`, sample: sample ?? "", maxLength: 500 }));
  },
  navigationEntries: [{
    id: "texts",
    label: { de: textLibraryModuleCatalog.de.label, en: textLibraryModuleCatalog.en.label },
    description: { de: textLibraryModuleCatalog.de.description, en: textLibraryModuleCatalog.en.description },
    showMainSwitch: false,
    iconKind: "texts",
    keywords: ["text", "texts", "texte", "textbausteine", "library", "bibliothek"],
  }],
  templateVariableNamespace: "text_blocks",
  resolveTemplateValues: (names, context) =>
    createTextBlockTemplateValueProvider(context.DB, context.channelId)(names, context),
  routes: textLibraryRoutes,
  panel: () => import("./panel/index"),
  eventSubTypes: ["channel.update", "stream.online", "stream.offline"],
  overlayElements: [{ ...textBlockOverlayElement, initialState: textBlockOverlayState }],
  handleEvent: (event) => event.subscriptionType === "channel.update" ||
    event.subscriptionType === "stream.online" || event.subscriptionType === "stream.offline"
    ? {
      actions: [{
        kind: "overlay",
        type: "state_changed",
        elementKind: TEXT_BLOCK_OVERLAY_ELEMENT_KIND,
        payload: { reason: event.subscriptionType },
      }],
      diagnostics: [],
    }
    : { actions: [], diagnostics: [] },
};
