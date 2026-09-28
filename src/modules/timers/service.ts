import { templateVariableNames, SYSTEM_TEMPLATE_VARIABLE_LIST, type TemplateVariable } from "../contract";
import type {
  ModuleRegisteredTemplateVariable,
  ModuleTemplateContentValidationContext,
  ModuleTemplateContentIssue,
} from "../contract";
import type { Timer, TimerMutationInput } from "./contracts";
import { TIMER_BLOCK_NAME_PATTERN, timerTriggerSchema } from "./contracts";

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
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export type TimerBlockValidation = { ok: true } | { ok: false; reason: "missing" | "input_dependent" };

const bareReferences = (text: string): string[] =>
  [...text.matchAll(/\{([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);

/** Rejects blocks whose nested templates require a chat command's caller or arguments. */
export const validateTimerBlock = async (
  db: D1Database,
  channelId: string,
  blockName: string,
  registeredVariables: readonly ModuleRegisteredTemplateVariable[],
  candidate?: { name: string; texts: readonly string[] },
): Promise<TimerBlockValidation> => {
  if (!TIMER_BLOCK_NAME_PATTERN.test(blockName)) return { ok: false, reason: "missing" };
  const inputVariables = new Set<string>();
  const allVariables: readonly TemplateVariable[] = [
    ...SYSTEM_TEMPLATE_VARIABLE_LIST,
    ...registeredVariables,
  ];
  for (const variable of allVariables) {
    const contexts = variable.contexts;
    if (contexts !== undefined && !contexts.includes("event") &&
        (contexts.includes("chat_command") || variable.unavailableContextText !== undefined)) {
      inputVariables.add(variable.name);
    }
  }
  const textBlockNames = new Set(registeredVariables.filter((variable) => variable.isTextBlock).map(({ name }) => name));
  const knownNames = new Set(allVariables.map(({ name }) => name).filter((name) => !textBlockNames.has(name)));
  const visited = new Set<string>();
  const visit = async (name: string, depth: number): Promise<TimerBlockValidation> => {
    if (visited.has(name)) return { ok: true };
    if (depth > 3) return { ok: false, reason: "missing" };
    visited.add(name);
    if (candidate?.name === name) {
      for (const text of candidate.texts) {
        if (templateVariableNames(text).some((variable) => inputVariables.has(variable))) {
          return { ok: false, reason: "input_dependent" };
        }
        const nested = [...new Set(bareReferences(text).filter((reference) => !knownNames.has(reference)))];
        for (const nestedName of nested) {
          const result = await visit(nestedName, depth + 1);
          if (!result.ok) return result;
        }
      }
      return { ok: true };
    }
    const block = await db.prepare(
      `SELECT variant.texts_json
         FROM text_block_variants AS variant
        WHERE variant.channel_id = ? AND variant.block_name = ?
        ORDER BY variant.position`,
    ).bind(channelId, name).all<{ texts_json: string }>();
    if (block.results.length === 0) return { ok: false, reason: "missing" };
    const texts = block.results.flatMap(({ texts_json }) => {
      try {
        const value: unknown = JSON.parse(texts_json);
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      } catch { return []; }
    });
    for (const text of texts) {
      if (templateVariableNames(text).some((variable) => inputVariables.has(variable))) {
        return { ok: false, reason: "input_dependent" };
      }
      const nested = [...new Set(bareReferences(text).filter((reference) => !knownNames.has(reference)))];
      for (const nestedName of nested) {
        const result = await visit(nestedName, depth + 1);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  };
  return await visit(blockName, 1);
};

export const validateTimerTemplateMutation = async (
  context: ModuleTemplateContentValidationContext,
): Promise<readonly ModuleTemplateContentIssue[]> => {
  const rows = await context.DB.prepare(
    "SELECT timer_id, name, block_name FROM timers WHERE channel_id = ? ORDER BY created_at, timer_id",
  ).bind(context.channelId).all<{ timer_id: string; name: string; block_name: string }>();
  const issues: ModuleTemplateContentIssue[] = [];
  const candidate = { name: context.candidate.name, texts: context.candidate.texts };
  for (const row of rows.results) {
    const validation = await validateTimerBlock(
      context.DB,
      context.channelId,
      row.block_name,
      context.registeredVariables,
      candidate,
    );
    if (!validation.ok && validation.reason === "input_dependent") {
      issues.push({ reason: "input_dependent", consumerName: row.name });
    }
  }
  return issues;
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
