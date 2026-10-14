import { z } from "zod";
import { columnVariableReferences } from "../contract";
import type { BotModule, ModuleTemplateContentValidationContext, ModuleTemplateUsageSource } from "../contract";
import { validateEventTemplateContentMutation } from "../contracts/text-block-validation";
import { createFaqRepository, purgeExpiredFaqUserCooldowns } from "./adapters/d1";
import { FAQ_MODULE_ID } from "./contracts";
import { faqRoutes } from "./routes";
import { processFaqMessage } from "./service";

const settingsSchema = z.object({});

const validateFaqTemplateMutation = async (context: ModuleTemplateContentValidationContext) => {
  const rows = await context.DB.prepare(
    "SELECT faq.name, faq.answer_text FROM faq_entries AS faq JOIN faq_entry_order AS entry_order ON entry_order.channel_id = faq.channel_id AND entry_order.faq_id = faq.faq_id WHERE faq.channel_id = ? ORDER BY entry_order.sort_order, faq.faq_id",
  ).bind(context.channelId).all<{ name: string; answer_text: string }>();
  return validateEventTemplateContentMutation(context, rows.results.map((row) => ({ name: row.name, text: row.answer_text })));
};

const templateUsageSources = async (db: D1Database, channelId: string): Promise<readonly ModuleTemplateUsageSource[]> => {
  const rows = await db.prepare("SELECT faq.faq_id, faq.name, faq.answer_text FROM faq_entries AS faq JOIN faq_entry_order AS entry_order ON entry_order.channel_id = faq.channel_id AND entry_order.faq_id = faq.faq_id WHERE faq.channel_id = ? ORDER BY entry_order.sort_order, faq.faq_id")
    .bind(channelId).all<{ faq_id: string; name: string; answer_text: string }>();
  return rows.results.map((row) => ({ text: row.answer_text, kind: "faq", label: row.name || row.faq_id }));
};

const faqVariableReferences = {
  ...columnVariableReferences({
    moduleId: FAQ_MODULE_ID,
    tableName: "faq_entries",
    idColumn: "faq_id",
    itemNameColumn: "name",
    textColumn: "answer_text",
    maxTextLength: 500,
  }),
  afterRename(db: D1Database, channelId: string) {
    createFaqRepository(db).invalidate(channelId);
  },
};

export const faqModule: BotModule<typeof settingsSchema> = {
  id: FAQ_MODULE_ID,
  navigationCategory: "chat",
  panelIcon: { paths: ["M4 5h16v14H4z", "M8 9h8", "M8 12h5", "M8 15h3"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateContext: "event",
  templateUsageSources,
  variableReferences: faqVariableReferences,
  validateTemplateContent: validateFaqTemplateMutation,
  afterTextBlockRename(db, channelId) {
    createFaqRepository(db).invalidate(channelId);
  },
  navigationEntries: [{
    id: "faq",
    label: { de: "FAQ & Auto-Antworten", en: "FAQ & Auto replies" },
    description: { de: "Chatfragen mit Textbausteinen beantworten", en: "Answer chat questions with text blocks" },
    iconKind: "faq",
    keywords: ["faq", "auto reply", "auto replies", "automatic answer", "automatische antwort", "auto-antwort", "chat answer"],
  }],
  eventSubTypes: ["channel.chat.message"],
  scheduledMaintenance: purgeExpiredFaqUserCooldowns,
  routes: faqRoutes,
  panel: () => import("./panel"),
  handleEvent: (event, context) => processFaqMessage(event, createFaqRepository(context.DB), context),
};
