import { z } from "zod";
import { columnVariableReferences } from "../contract";
import type { BotModule, ModuleDryRunContext, ModuleEvent, ModuleTemplateContentValidationContext, ModuleTemplateUsageSource } from "../contract";
import type { DryRunBlockCode, DryRunEffect, DryRunEntryReport } from "../../contracts/dry-run";
import type { ChatOutputTarget } from "../../contracts/values";
import { validateEventTemplateContentMutation } from "../contracts/text-block-validation";
import { createFaqPeekRepository, createFaqRepository, purgeExpiredFaqUserCooldowns } from "./adapters/d1";
import { FAQ_MODULE_ID } from "./contracts";
import { explainFaqMatches } from "./domain";
import type { FaqClaimResult } from "./repository";
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

const dryRunBlockCodes = {
  command_prefix: "faq.command_prefix",
  permission_denied: "faq.permission_denied",
  game_filter: "faq.game_filter",
  shadowed: "faq.shadowed",
} as const satisfies Readonly<Record<Exclude<ReturnType<typeof explainFaqMatches>[number]["reason"], null>, DryRunBlockCode>>;

const textFromEvent = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
};

const dryRunFaqMessage = async (
  event: ModuleEvent,
  context: ModuleDryRunContext,
): Promise<readonly DryRunEntryReport[]> => {
  const text = textFromEvent(event);
  if (event.subscriptionType !== "channel.chat.message" || text === null || text.length === 0) return [];
  const botUserId = await context.botUserId?.() ?? null;
  if (botUserId === null) return [];
  const senderId = typeof event.payload.chatter_user_id === "string" ? event.payload.chatter_user_id : null;
  const claimState: { result: FaqClaimResult | null } = { result: null };
  const repository = createFaqPeekRepository(context.DB, (claim) => { claimState.result = claim; });
  const prepared = await repository.matchers(event.channelId);
  const gameId = await context.channelGameId?.() ?? null;
  const explanations = explainFaqMatches(prepared, text, gameId, event.chatStatus);
  if (explanations.length === 0) return [];

  const result = await processFaqMessage(event, repository, context);
  const claimResult = claimState.result;
  const ownMessage = senderId !== null && senderId === botUserId;
  const selectedExplanation = explanations.find(({ reason }) => reason === null);
  const chatAction = result.actions.find((action) => action.kind === "chat");
  const fires = claimResult?.claimed === true;
  const effects: DryRunEffect[] = [];
  if (fires && chatAction?.kind === "chat") {
    const target: ChatOutputTarget = chatAction.target ?? context.defaultChatTarget;
    const sourceBroadcasterId = event.payload.source_broadcaster_user_id;
    const sourceOnly = target === "source_only" || (
      target === "where_asked" &&
      (typeof sourceBroadcasterId !== "string" || sourceBroadcasterId === event.channelId)
    );
    effects.push({
      kind: "chat",
      text: chatAction.text,
      target,
      postsTo: sourceOnly ? "this_chat" : "all_shared_chats",
      reply: chatAction.replyToMessageId !== undefined,
      suppressedBy: null,
      automated: chatAction.automated ?? true,
      ...(result.attributions === undefined || result.attributions.length === 0 ? {} : { attributions: result.attributions }),
    });
  }

  const reports = explanations.map((explanation): DryRunEntryReport => {
    const isSelected = selectedExplanation?.entry.id === explanation.entry.id;
    const blocks: DryRunEntryReport["blocks"][number][] = [];
    if (ownMessage) {
      blocks.push({ code: "faq.own_message" });
    } else if (explanation.reason !== null) {
      blocks.push({
        code: dryRunBlockCodes[explanation.reason],
        ...(explanation.byEntryId === undefined ? {} : { detail: { byEntryId: explanation.byEntryId } }),
      });
    } else if (isSelected && claimResult?.claimed === false) {
      if (claimResult.reason === "cooldown") {
        blocks.push({ code: "faq.cooldown", detail: { remainingSeconds: claimResult.remainingSeconds } });
      } else if (claimResult.reason === "person_cooldown") {
        blocks.push({ code: "faq.person_cooldown", detail: { remainingSeconds: claimResult.remainingSeconds } });
      }
    }

    const entryEffects: DryRunEffect[] = isSelected && fires ? [...effects] : [];
    if (isSelected && fires) {
      if (explanation.entry.cooldownSeconds > 0) {
        entryEffects.push({ kind: "cooldown", scope: "global", seconds: explanation.entry.cooldownSeconds });
      }
      if (explanation.entry.userCooldownSeconds > 0) {
        entryEffects.push({ kind: "cooldown", scope: "user", seconds: explanation.entry.userCooldownSeconds });
      }
    }

    return {
      moduleId: FAQ_MODULE_ID,
      entry: { kind: "faq_entry", id: explanation.entry.id, label: explanation.entry.name },
      outcome: isSelected && fires ? "fires" : "blocked",
      match: explanation.match,
      blocks,
      effects: entryEffects,
      templateNotes: isSelected ? result.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("template.")) : [],
    };
  });
  return reports;
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
  dryRunChatMessage: dryRunFaqMessage,
};
