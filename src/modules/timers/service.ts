import type {
  ModuleTemplateContentValidationContext,
  ModuleTemplateContentIssue,
} from "../contract";
import type { Timer, TimerMutationInput } from "./contracts";
import { TIMER_MESSAGE_MAX_LENGTH, timerTriggerSchema } from "./contracts";
import { validateEventTemplateContentMutation, validateEventTemplateText, type EventTextBlockValidation } from "../contracts/text-block-validation";
import { templateTextLength } from "../../contracts/template-text-length";

export type TimerTextValidation = EventTextBlockValidation;
export const validateTimerText = validateEventTemplateText;

export interface TimerRow {
  timer_id: string;
  name: string;
  enabled: number;
  message_text: string;
  trigger_type: string;
  trigger_json: string;
  chat_target?: Timer["chatTarget"];
  revision: number;
  next_run_at: string | null;
  next_run_stream_id: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export const mapTimerRow = (row: TimerRow): Timer => {
  let trigger: unknown;
  try { trigger = JSON.parse(row.trigger_json) as unknown; } catch { trigger = null; }
  const parsed = timerTriggerSchema.safeParse(trigger);
  if (!parsed.success || parsed.data.type !== row.trigger_type) throw new Error("Stored timer trigger is invalid.");
  return {
    id: row.timer_id,
    name: row.name,
    enabled: row.enabled === 1,
    messageText: row.message_text,
    chatTarget: row.chat_target ?? "source_only",
    trigger: parsed.data,
    revision: row.revision,
    nextRunAt: row.next_run_at,
    nextRunStreamId: row.next_run_stream_id,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const validateTimerTemplateMutation = async (
  context: ModuleTemplateContentValidationContext,
): Promise<readonly ModuleTemplateContentIssue[]> => {
  const rows = await context.DB.prepare(
    "SELECT timer_id, name, message_text FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id",
  ).bind(context.channelId).all<{ timer_id: string; name: string; message_text: string }>();
  return validateEventTemplateContentMutation(context, rows.results.map((row) => ({ name: row.name, text: row.message_text })));
};

export const timerMutationInput = (value: unknown): TimerMutationInput | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length < 1 || record.name.trim().length > 60 ||
      typeof record.messageText !== "string" || record.messageText.trim().length === 0 ||
      templateTextLength(record.messageText) > TIMER_MESSAGE_MAX_LENGTH) return null;
  const parsed = timerTriggerSchema.safeParse(record.trigger);
  if (!parsed.success) return null;
  const chatTarget = record.chatTarget === undefined ? "source_only" : record.chatTarget;
  if (chatTarget !== "all_chats" && chatTarget !== "source_only") return null;
  return { name: record.name.trim(), messageText: record.messageText, chatTarget, trigger: parsed.data };
};
