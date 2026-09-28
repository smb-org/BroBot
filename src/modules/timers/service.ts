import type {
  ModuleTemplateContentValidationContext,
  ModuleTemplateContentIssue,
} from "../contract";
import type { Timer, TimerMutationInput } from "./contracts";
import { TIMER_BLOCK_NAME_PATTERN, timerTriggerSchema } from "./contracts";
import { validateEventTextBlock, validateEventTextBlockMutation, type EventTextBlockValidation } from "../contracts/text-block-validation";

export type TimerBlockValidation = EventTextBlockValidation;
export const validateTimerBlock = validateEventTextBlock;

export interface TimerRow {
  timer_id: string;
  name: string;
  enabled: number;
  block_name: string;
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
    blockName: row.block_name,
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
    "SELECT timer_id, name, block_name FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id",
  ).bind(context.channelId).all<{ timer_id: string; name: string; block_name: string }>();
  return validateEventTextBlockMutation(context, rows.results.map((row) => ({ name: row.name, blockName: row.block_name })));
};

export const timerMutationInput = (value: unknown): TimerMutationInput | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.trim().length < 1 || record.name.trim().length > 60 ||
      typeof record.blockName !== "string" || !TIMER_BLOCK_NAME_PATTERN.test(record.blockName)) return null;
  const parsed = timerTriggerSchema.safeParse(record.trigger);
  if (!parsed.success) return null;
  const chatTarget = record.chatTarget === undefined ? "source_only" : record.chatTarget;
  if (chatTarget !== "all_chats" && chatTarget !== "source_only") return null;
  return { name: record.name.trim(), blockName: record.blockName, chatTarget, trigger: parsed.data };
};
