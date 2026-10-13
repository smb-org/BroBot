import type {
  ModuleTemplateContentValidationContext,
  ModuleTemplateContentIssue,
} from "../contract";
import type { Timer, TimerMutationInput } from "./contracts";
import { TIMER_MESSAGE_MAX_LENGTH, timerTriggerSchema } from "./contracts";
import { validateEventTemplateContentMutation, validateEventTemplateText } from "../contracts/text-block-validation";
import { templateTextLength } from "../../contracts/template-text-length";

export const validateTimerText = validateEventTemplateText;

export interface TimerRow {
  timer_id: string;
  name: string;
  enabled: number;
  message_text: string;
  trigger_type: string;
  trigger_json: string;
  chat_target?: Exclude<Timer["chatTarget"], null>;
  use_channel_default_target?: number;
  revision: number;
  next_run_at: string | null;
  next_run_state: "live" | "offline" | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

type LegacyIntervalApiTrigger = Extract<Timer["trigger"], { type: "interval" }> & {
  minutes: number;
  minimumMessages?: number;
};

export type TimerApiResponse = Omit<Timer, "trigger"> & {
  trigger: Timer["trigger"] | LegacyIntervalApiTrigger;
};

/** Accepts the pre-live/offline interval shape while keeping reads canonical. */
const normalizeTimerTrigger = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const trigger = value as Record<string, unknown>;
  if (trigger.type !== "interval" || typeof trigger.minutes !== "number") return value;
  if (trigger.live !== undefined || trigger.offline !== undefined) return value;
  return {
    type: "interval",
    live: {
      minutes: trigger.minutes,
      ...(trigger.minimumMessages === undefined ? {} : { minimumMessages: trigger.minimumMessages }),
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps the live/offline split when an older client edits only the legacy live interval. */
export const preserveOfflineIntervalForLegacyMutation = (
  submitted: Timer["trigger"],
  current: Timer["trigger"],
  rawSubmitted: unknown,
): Timer["trigger"] => {
  if (!isRecord(rawSubmitted) || rawSubmitted.type !== "interval" || typeof rawSubmitted.minutes !== "number" ||
      rawSubmitted.live !== undefined || rawSubmitted.offline !== undefined || submitted.type !== "interval" ||
      current.type !== "interval" || current.offline === undefined) return submitted;
  return { ...submitted, offline: current.offline };
};

/** Writes interval JSON that newer workers read canonically and older workers can still parse. */
export const timerTriggerJson = (trigger: Timer["trigger"]): string => {
  if (trigger.type !== "interval") return JSON.stringify(trigger);
  // Old workers interpret the legacy top-level interval as live. Keep that
  // compatibility shape only when a live interval exists; inventing it from
  // an offline-only interval would let an old worker send in the wrong state.
  if (trigger.live === undefined) return JSON.stringify(trigger);
  return JSON.stringify({ ...trigger, minutes: trigger.live.minutes,
    ...(trigger.live.minimumMessages === undefined ? {} : { minimumMessages: trigger.live.minimumMessages }) });
};

export const mapTimerRow = (row: TimerRow): Timer => {
  let trigger: unknown;
  try { trigger = JSON.parse(row.trigger_json) as unknown; } catch { trigger = null; }
  const parsed = timerTriggerSchema.safeParse(normalizeTimerTrigger(trigger));
  if (!parsed.success || parsed.data.type !== row.trigger_type) throw new Error("Stored timer trigger is invalid.");
  return {
    id: row.timer_id,
    name: row.name,
    enabled: row.enabled === 1,
    messageText: row.message_text,
    chatTarget: row.use_channel_default_target === 1 ? null : row.chat_target ?? "source_only",
    trigger: parsed.data,
    revision: row.revision,
    nextRunAt: row.next_run_at,
    nextRunState: row.next_run_state,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** Keeps active older dashboards readable while returning canonical live/offline fields. */
export const timerForApiResponse = (timer: Timer): TimerApiResponse => {
  if (timer.trigger.type !== "interval" || timer.trigger.live === undefined) return timer;
  return {
    ...timer,
    trigger: {
      ...timer.trigger,
      minutes: timer.trigger.live.minutes,
      ...(timer.trigger.live.minimumMessages === undefined ? {} : { minimumMessages: timer.trigger.live.minimumMessages }),
    },
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
  const parsed = timerTriggerSchema.safeParse(normalizeTimerTrigger(record.trigger));
  if (!parsed.success) return null;
  const chatTarget = record.chatTarget === undefined || record.chatTarget === null ? null : record.chatTarget;
  if (chatTarget !== null && chatTarget !== "all_chats" && chatTarget !== "source_only") return null;
  return { name: record.name.trim(), messageText: record.messageText, chatTarget, trigger: parsed.data };
};
