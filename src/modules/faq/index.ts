import { z } from "zod";
import type { BotModule, ModuleTemplateContentValidationContext } from "../contract";
import { validateEventTextBlockMutation } from "../contracts/text-block-validation";
import { createFaqRepository } from "./adapters/d1";
import { FAQ_MODULE_ID } from "./contracts";
import { faqRoutes } from "./routes";
import { processFaqMessage } from "./service";

const settingsSchema = z.object({});

const validateFaqTemplateMutation = async (context: ModuleTemplateContentValidationContext) => {
  const rows = await context.DB.prepare(
    "SELECT name, answer_block FROM faq_entries WHERE channel_id = ? ORDER BY sort_order, faq_id",
  ).bind(context.channelId).all<{ name: string; answer_block: string }>();
  return validateEventTextBlockMutation(context, rows.results.map((row) => ({ name: row.name, blockName: row.answer_block })));
};

export const faqModule: BotModule<typeof settingsSchema> = {
  id: FAQ_MODULE_ID,
  navigationCategory: "chat",
  panelIcon: { paths: ["M4 5h16v14H4z", "M8 9h8", "M8 12h5", "M8 15h3"] },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateContext: "event",
  validateTemplateContent: validateFaqTemplateMutation,
  navigationEntries: [{
    id: "faq",
    label: { de: "FAQ & Auto-Antworten", en: "FAQ & Auto replies" },
    description: { de: "Chatfragen mit Textbausteinen beantworten", en: "Answer chat questions with text blocks" },
    iconKind: "faq",
    keywords: ["faq", "auto reply", "auto replies", "automatic answer", "automatische antwort", "auto-antwort", "chat answer"],
  }],
  eventSubTypes: ["channel.chat.message"],
  routes: faqRoutes,
  panel: () => import("./panel"),
  handleEvent: (event, context) => processFaqMessage(event, createFaqRepository(context.DB), context),
};

export type { FaqEntry, FaqGame, FaqMatcher, FaqMutationInput } from "./contracts";
