import type {
  TextCommand,
  TextCommandGame,
  TextCommandKind,
  TextCommandMinimumTier,
  TextCommandResponseType,
  TextCommandStreamCondition,
  TextCommandVariableAction,
} from "../contracts";
import type { ModuleRegisteredTemplateVariable } from "../../contract";
import { TEXT_COMMAND_DEFAULT_TEXTS, TEXT_COMMAND_DEFAULT_USAGE_TEXT } from "../contracts/chat-defaults";

export interface CommandKindDraft {
  text: string;
  usageText: string;
  variableAction: TextCommand["variableAction"];
  timeoutAction: { minSeconds: number | ""; maxSeconds: number | ""; fallbackText: string; reason: string } | null;
}

type CommandKindDrafts = Partial<Record<TextCommandKind, CommandKindDraft>>;

export interface CommandDraft extends CommandKindDraft {
  name: string;
  enabled: boolean;
  kind: TextCommandKind;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number | "";
  aliases: string[];
  userCooldownSeconds: number | "";
  streamCondition: TextCommandStreamCondition;
  games: TextCommandGame[];
  responseType: TextCommandResponseType;
  chatTarget: TextCommand["chatTarget"];
  kindDrafts: CommandKindDrafts;
}

const defaultKindDraft = (kind: TextCommandKind): CommandKindDraft => ({
  text: kind === "shoutout" ? TEXT_COMMAND_DEFAULT_TEXTS.shoutout : "",
  usageText: kind === "shoutout" ? TEXT_COMMAND_DEFAULT_USAGE_TEXT : "",
  variableAction: null,
  timeoutAction: kind === "timeout" ? { minSeconds: 120, maxSeconds: 120, fallbackText: "", reason: "" } : null,
});

const fieldsForKind = (draft: CommandDraft): CommandKindDraft => ({
  text: draft.text,
  usageText: draft.usageText,
  variableAction: draft.variableAction === null ? null : { ...draft.variableAction },
  timeoutAction: draft.timeoutAction === null ? null : { ...draft.timeoutAction },
});

export const switchTextCommandKind = (
  draft: CommandDraft,
  kind: TextCommandKind,
  isCreate: boolean,
): CommandDraft => {
  if (kind === draft.kind) return draft;
  const kindDrafts = { ...draft.kindDrafts, [draft.kind]: fieldsForKind(draft) };
  const nextFields = kindDrafts[kind] ?? defaultKindDraft(kind);
  return {
    ...draft,
    ...nextFields,
    kind,
    kindDrafts,
    ...(isCreate && kind === "shoutout" ? { minimumTier: "moderator" as const } : {}),
  };
};

export const keepOnlyActiveKindDraft = (draft: CommandDraft): CommandDraft => ({
  ...draft,
  kindDrafts: { [draft.kind]: fieldsForKind(draft) },
});

export type CurrencyTemplateField = "text" | "usageText" | "timeoutFallbackText" | "timeoutReason";

export interface CurrencyTokenTarget {
  id: string;
  field: CurrencyTemplateField;
  index: number;
  from: string;
  to: string;
}

export const currencyTokenTargets = (
  templates: readonly { field: CurrencyTemplateField; value: string }[],
): CurrencyTokenTarget[] => templates.flatMap(({ field, value }) => {
  const targets: CurrencyTokenTarget[] = [];
  const pattern = /\{currency\.convert(?:\s+([A-Za-z]{3})\s+([A-Za-z]{3}))?\}/giu;
  for (const match of value.matchAll(pattern)) {
    const index = targets.length;
    targets.push({
      id: `${field}:${String(index)}`,
      field,
      index,
      from: match[1]?.toUpperCase() ?? "USD",
      to: match[2]?.toUpperCase() ?? "EUR",
    });
  }
  return targets;
});

export const replaceCurrencyTokenAt = (template: string, index: number, from: string, to: string): string => {
  let occurrence = 0;
  return template.replace(/\{currency\.convert(?:\s+[A-Za-z]{3}\s+[A-Za-z]{3})?\}/giu, (token) => {
    const current = occurrence;
    occurrence += 1;
    return current === index ? `{currency.convert ${from} ${to}}` : token;
  });
};

export const isSystemTemplateModuleId = (moduleId: string): boolean => moduleId === "core" || moduleId === "host";

export const modulesUsedByCommand = (
  command: Pick<TextCommand, "text" | "usageText" | "timeoutAction">,
  variables: readonly ModuleRegisteredTemplateVariable[],
): string[] => {
  const moduleByVariable = new Map(variables.map((variable) => [variable.name, variable.moduleId]));
  const templateText = [command.text, command.usageText ?? "", command.timeoutAction?.fallbackText ?? "", command.timeoutAction?.reason ?? ""].join(" ");
  return [...new Set([...templateText.matchAll(/\{([a-z][a-z0-9_.]*)/giu)]
    .map((match) => moduleByVariable.get(match[1] ?? ""))
    .filter((moduleId): moduleId is string => moduleId !== undefined))];
};

export const minimumTierAfterVariableOperation = (
  current: TextCommandMinimumTier,
  operation: TextCommandVariableAction["operation"],
  explicitlyChosen: boolean,
): TextCommandMinimumTier => operation === "set_argument" && !explicitlyChosen && current === "everyone"
  ? "moderator"
  : current;
