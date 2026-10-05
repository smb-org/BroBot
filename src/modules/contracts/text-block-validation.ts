import type {
  ModuleRegisteredTemplateVariable,
  ModuleTemplateContentCandidate,
  ModuleTemplateContentIssue,
  ModuleTemplateContentValidationContext,
} from "../contract";
import { templateVariableNames, SYSTEM_TEMPLATE_VARIABLE_LIST, type TemplateVariable } from "../contract";
import { blockReferencesInText } from "./text-block-references";

export type EventTextBlockValidation = { ok: true } | { ok: false; reason: "missing" | "input_dependent" };

/** Validates a text block used without chat-command input, including nested blocks. */
export const validateEventTextBlock = async (
  db: D1Database,
  channelId: string,
  blockName: string,
  registeredVariables: readonly ModuleRegisteredTemplateVariable[],
  candidate?: ModuleTemplateContentCandidate,
): Promise<EventTextBlockValidation> => {
  if (!/^[a-z][a-z0-9_]{0,31}$/u.test(blockName)) return { ok: false, reason: "missing" };
  const inputVariables = new Set<string>();
  const allVariables: readonly TemplateVariable[] = [...SYSTEM_TEMPLATE_VARIABLE_LIST, ...registeredVariables];
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
  const visit = async (name: string, depth: number): Promise<EventTextBlockValidation> => {
    if (visited.has(name)) return { ok: true };
    if (depth > 3) return { ok: false, reason: "missing" };
    visited.add(name);
    let texts: readonly string[];
    if (candidate?.name === name) {
      texts = candidate.texts;
    } else {
      const block = await db.prepare(
        `SELECT variant.texts_json
           FROM text_block_variants AS variant
          WHERE variant.channel_id = ? AND variant.block_name = ?
          ORDER BY variant.position`,
      ).bind(channelId, name).all<{ texts_json: string }>();
      if (block.results.length === 0) return { ok: false, reason: "missing" };
      texts = block.results.flatMap(({ texts_json }) => {
        try {
          const value: unknown = JSON.parse(texts_json);
          return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        } catch { return []; }
      });
    }
    for (const text of texts) {
      if (templateVariableNames(text).some((variable) => inputVariables.has(variable))) {
        return { ok: false, reason: "input_dependent" };
      }
      const nested = blockReferencesInText(text).filter((reference) => !knownNames.has(reference));
      for (const nestedName of nested) {
        const result = await visit(nestedName, depth + 1);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  };
  return await visit(blockName, 1);
};

/** Implements the generic template-content validation contract for one module's consumers. */
export const validateEventTextBlockMutation = async (
  context: ModuleTemplateContentValidationContext,
  consumers: readonly { name: string; blockName: string }[],
): Promise<readonly ModuleTemplateContentIssue[]> => {
  const issues: ModuleTemplateContentIssue[] = [];
  for (const consumer of consumers) {
    const validation = await validateEventTextBlock(
      context.DB,
      context.channelId,
      consumer.blockName,
      context.registeredVariables,
      context.candidate,
    );
    if (!validation.ok && validation.reason === "input_dependent") {
      issues.push({ reason: "input_dependent", consumerName: consumer.name });
    }
  }
  return issues;
};
