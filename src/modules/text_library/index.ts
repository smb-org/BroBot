import { z } from "zod";

import { moduleVariableRenameTarget } from "../contract";
import type { BotModule, ModuleVariableReferences } from "../contract";
import { textLibraryModuleCatalog } from "./catalog";
import { textLibraryRoutes } from "./routes";
import { createTextBlockTemplateValueProvider } from "./adapters/template-expander";
import { textBlockOverlayElement, TEXT_BLOCK_OVERLAY_ELEMENT_KIND } from "./overlay/element";
import { textBlockOverlayState } from "./overlay/state";
import { templateTextLength } from "../../contracts/template-text-length";

const settingsSchema = z.object({});

const variableReferences: ModuleVariableReferences = {
  async usages(db, channelId, name) {
    const token = `{var.${name}}`;
    const rows = await db.prepare(
      `SELECT DISTINCT block_name
         FROM text_block_variants
        WHERE channel_id = ? AND instr(texts_json, ?) > 0
        ORDER BY block_name`,
    ).bind(channelId, token).all<{ block_name: string }>();
    return rows.results.map(({ block_name }) => ({
      moduleId: "text_library",
      itemName: block_name,
      kind: "template" as const,
    }));
  },
  async validateRename(db, channelId, from, to) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    const rows = await db.prepare(
      `SELECT block_name, variant_id, texts_json
         FROM text_block_variants
        WHERE channel_id = ? AND instr(texts_json, ?) > 0
        ORDER BY block_name, variant_id`,
    ).bind(channelId, oldToken).all<{ block_name: string; variant_id: string; texts_json: string }>();
    const snapshot = rows.results.map(({ block_name, variant_id, texts_json }) => [block_name, variant_id, texts_json]);
    const blocks = new Set<string>();
    for (const row of rows.results) {
      let texts: unknown;
      try { texts = JSON.parse(row.texts_json) as unknown; } catch { continue; }
      if (!Array.isArray(texts)) continue;
      if (texts.some((text) => typeof text === "string" && text.includes(oldToken) &&
          templateTextLength(text.replaceAll(oldToken, nextToken)) > 500)) {
        blocks.add(row.block_name);
      }
    }
    const snapshotJson = JSON.stringify(snapshot);
    return {
      usages: [...blocks].map((itemName) => ({
        moduleId: "text_library",
        itemName,
        kind: "template" as const,
      })),
      precondition: {
        sql: `NOT EXISTS (
          SELECT 1 FROM (
            SELECT source.block_name, source.variant_id, source.texts_json
              FROM text_block_variants AS source
             WHERE source.channel_id = ? AND instr(source.texts_json, ?) > 0
            EXCEPT
            SELECT json_extract(snapshot.value, '$[0]'), json_extract(snapshot.value, '$[1]'), json_extract(snapshot.value, '$[2]')
              FROM json_each(?) AS snapshot
          )
        ) AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT json_extract(snapshot.value, '$[0]'), json_extract(snapshot.value, '$[1]'), json_extract(snapshot.value, '$[2]')
              FROM json_each(?) AS snapshot
            EXCEPT
            SELECT source.block_name, source.variant_id, source.texts_json
              FROM text_block_variants AS source
             WHERE source.channel_id = ? AND instr(source.texts_json, ?) > 0
          )
        )`,
        values: [channelId, oldToken, snapshotJson, snapshotJson, channelId, oldToken],
      },
    };
  },
  rename(db, channelId, from, to, guard) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    const target = moduleVariableRenameTarget(channelId, to, guard);
    const updateBlockRevisions = db.prepare(
      `UPDATE text_blocks
          SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE channel_id = ?
          AND EXISTS (
            SELECT 1 FROM text_block_variants AS variant
             WHERE variant.channel_id = text_blocks.channel_id
               AND variant.block_name = text_blocks.block_name
               AND instr(variant.texts_json, ?) > 0
          )
          AND ${target.sql}
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(channelId, oldToken, ...target.values, channelId, from);
    const rewriteVariants = db.prepare(
      `UPDATE text_block_variants
          SET texts_json = replace(texts_json, ?, ?)
        WHERE channel_id = ? AND instr(texts_json, ?) > 0
          AND ${target.sql}
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, channelId, oldToken, ...target.values, channelId, from);
    return [updateBlockRevisions, rewriteVariants];
  },
};

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
  variableReferences,
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
