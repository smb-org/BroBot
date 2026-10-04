import type { TextCommandMinimumTier, TextCommandVariableAction } from "../contracts";
import { templateVariableNames, type TemplateVariable } from "../contract";

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
): boolean => {
  const names = new Set(templateVariableNames(text));
  return variables.some((variable) => variable.parameters !== undefined && names.has(variable.name));
};
