import type { TextCommandMinimumTier, TextCommandVariableAction } from "../contracts";

export const minimumTierAfterVariableOperation = (
  current: TextCommandMinimumTier,
  operation: TextCommandVariableAction["operation"],
  explicitlyChosen: boolean,
): TextCommandMinimumTier => operation === "set_argument" && !explicitlyChosen && current === "everyone"
  ? "moderator"
  : current;
