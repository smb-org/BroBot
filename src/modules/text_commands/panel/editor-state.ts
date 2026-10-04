import type { TextCommandMinimumTier, TextCommandVariableAction } from "../contracts";
import { templateVariableNames, type TemplateVariable } from "../contract";
import { blockReferencesInText } from "../../contracts/text-block-references";

export const minimumTierAfterVariableOperation = (
  current: TextCommandMinimumTier,
  operation: TextCommandVariableAction["operation"],
  explicitlyChosen: boolean,
): TextCommandMinimumTier => operation === "set_argument" && !explicitlyChosen && current === "everyone"
  ? "moderator"
  : current;

export const usesParameterizedTemplateVariable = (
  text: string,
  variables: readonly Pick<TemplateVariable, "name" | "parameters">[],
  textBlockTexts: ReadonlyMap<string, readonly string[]> = new Map(),
): boolean => {
  const pending = [text];
  const visitedBlocks = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    const names = new Set(templateVariableNames(current));
    if (variables.some((variable) => variable.parameters !== undefined && names.has(variable.name))) return true;
    for (const blockName of blockReferencesInText(current)) {
      if (visitedBlocks.has(blockName)) continue;
      visitedBlocks.add(blockName);
      pending.push(...(textBlockTexts.get(blockName) ?? []));
    }
  }
  return false;
};

export const textCommandConsumesArguments = (
  text: string,
  variables: readonly Pick<TemplateVariable, "name" | "parameters">[],
  textBlockTexts: ReadonlyMap<string, readonly string[]>,
  variableAction: TextCommandVariableAction | null,
): boolean => variableAction?.operation === "set_argument" ||
  usesParameterizedTemplateVariable(text, variables, textBlockTexts);
