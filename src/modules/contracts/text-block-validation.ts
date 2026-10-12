import type {
  ModuleRegisteredTemplateVariable,
  ModuleTemplateContentCandidate,
  ModuleTemplateContentIssue,
  ModuleTemplateContentValidationContext,
} from "../contract";
import { templateVariableNames, SYSTEM_TEMPLATE_VARIABLE_LIST } from "../contract";
import { isEventTemplateVariableAvailable } from "../../contracts/event-template-variables";
import { blockReferencesInText, rewriteTextBlockReference } from "./text-block-references";

export type EventTextBlockValidation = { ok: true } | { ok: false; reason: "missing" | "input_dependent" };

/** Keeps an event-resolvable declaration when a later declaration with the same name is unavailable. */
export const effectiveEventTemplateDeclarations = <Declaration extends {
  name: string;
  contexts?: readonly ("chat_command" | "event" | "system")[];
  availableInEventTemplates?: boolean;
}>(declarations: readonly Declaration[]): Declaration[] => {
  const byName = new Map<string, Declaration>();
  for (const declaration of declarations) {
    const current = byName.get(declaration.name);
    if (current === undefined || isEventTemplateVariableAvailable(declaration) || !isEventTemplateVariableAvailable(current)) {
      byName.set(declaration.name, declaration);
    }
  }
  return [...byName.values()];
};

const inputVariablesForEvent = (registeredVariables: readonly ModuleRegisteredTemplateVariable[]): Set<string> => {
  return new Set(effectiveEventTemplateDeclarations([...SYSTEM_TEMPLATE_VARIABLE_LIST, ...registeredVariables])
    .filter((variable) => !isEventTemplateVariableAvailable(variable))
    .map((variable) => variable.name));
};

/** Validates a text block used without chat-command input, including nested blocks. */
const validateEventTextBlock = async (
  db: D1Database,
  channelId: string,
  blockName: string,
  registeredVariables: readonly ModuleRegisteredTemplateVariable[],
  candidate?: ModuleTemplateContentCandidate,
): Promise<EventTextBlockValidation> => {
  if (!/^[a-z0-9_]{1,32}$/u.test(blockName)) return { ok: false, reason: "missing" };
  const inputVariables = inputVariablesForEvent(registeredVariables);
  const renamedFrom = candidate?.renamedFrom;
  const visited = new Set<string>();
  const visit = async (name: string, depth: number): Promise<EventTextBlockValidation> => {
    const resolvedName = renamedFrom === name ? candidate?.name ?? name : name;
    if (visited.has(resolvedName)) return { ok: true };
    if (depth > 3) return { ok: false, reason: "missing" };
    visited.add(resolvedName);
    let texts: readonly string[];
    if (candidate?.name === resolvedName) {
      texts = candidate.texts;
    } else {
      const block = await db.prepare(
        `SELECT variant.texts_json
           FROM text_block_variants AS variant
          WHERE variant.channel_id = ? AND variant.block_name = ?
          ORDER BY variant.position`,
      ).bind(channelId, resolvedName).all<{ texts_json: string }>();
      if (block.results.length === 0) return { ok: false, reason: "missing" };
      texts = block.results.flatMap(({ texts_json }) => {
        try {
          const value: unknown = JSON.parse(texts_json);
          return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        } catch { return []; }
      });
    }
    const resolvedTexts = renamedFrom === undefined || candidate === undefined
      ? texts
      : texts.map((text) => rewriteTextBlockReference(text, renamedFrom, candidate.name));
    for (const text of resolvedTexts) {
      if (templateVariableNames(text).some((variable) => inputVariables.has(variable))) {
        return { ok: false, reason: "input_dependent" };
      }
      for (const nestedName of blockReferencesInText(text)) {
        const result = await visit(nestedName, depth + 1);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  };
  return await visit(blockName, 1);
};

/** Validates a free-text template and every text block it embeds for event use. */
export const validateEventTemplateText = async (
  db: D1Database,
  channelId: string,
  text: string,
  registeredVariables: readonly ModuleRegisteredTemplateVariable[],
  candidate?: ModuleTemplateContentCandidate,
): Promise<EventTextBlockValidation> => {
  const inputVariables = inputVariablesForEvent(registeredVariables);
  if (templateVariableNames(text).some((name) => inputVariables.has(name))) {
    return { ok: false, reason: "input_dependent" };
  }
  for (const blockName of blockReferencesInText(text)) {
    const validation = await validateEventTextBlock(db, channelId, blockName, registeredVariables, candidate);
    if (!validation.ok) return validation;
  }
  return { ok: true };
};

/** Implements the generic template-content validation contract for one module's consumers. */
export const validateEventTemplateContentMutation = async (
  context: ModuleTemplateContentValidationContext,
  consumers: readonly { name: string; text: string }[],
): Promise<readonly ModuleTemplateContentIssue[]> => {
  const issues: ModuleTemplateContentIssue[] = [];
  const renamedFrom = context.candidate.renamedFrom;
  const candidate = renamedFrom === undefined
    ? context.candidate
    : {
      ...context.candidate,
      texts: context.candidate.texts.map((text) =>
        rewriteTextBlockReference(text, renamedFrom, context.candidate.name)),
    };
  for (const consumer of consumers) {
    const validation = await validateEventTemplateText(
      context.DB,
      context.channelId,
      renamedFrom === undefined
        ? consumer.text
        : rewriteTextBlockReference(consumer.text, renamedFrom, context.candidate.name),
      context.registeredVariables,
      candidate,
    );
    if (!validation.ok && validation.reason === "input_dependent") {
      issues.push({ reason: "input_dependent", consumerName: consumer.name });
    }
  }
  return issues;
};
