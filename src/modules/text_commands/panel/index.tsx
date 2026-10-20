import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import "./panel.css";

import { dashboardCommonTexts, dashboardLanguage, serverFieldErrorText, type DashboardLanguage } from "../../../dashboard/locale";
import {
  ActionMenu, Badge, Button, ChatTargetField, ChatPreview, ChipGroup, ChipsInput, CollectionPage, ConfirmDialog, EmptyState,
  Field, FieldPair, GameMultiSelect, LoadState, LoadStateLines, ListToolbar, PageHeader, RuleNote,
  mapServerFieldErrors, registerDashboardNavigationGuard, RoleThreshold, SaveStatus, Section, SegmentChoice, Select, StatusLed,
  SwitchSection, TemplateTextField, TimeoutDurationRangeFields, UnitInput, useDraft, useDraftGuard, useInspectorSelection, notify,
} from "../../../dashboard/ui";
import { Switch as SwitchPrimitive } from "../../../dashboard/ui/primitives/switch";
import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_COMMAND_KINDS, TEXT_COMMAND_MAX_ALIASES, TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TEMPLATE_FIELDS, TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, type TextCommand, type TextCommandKind, type TextCommandMinimumTier } from "../contracts";
import { MODERATION_TIMEOUT_MAX_SECONDS } from "../../contracts/moderation";
import {
  currencyTokenTargets,
  isSystemTemplateModuleId,
  keepOnlyActiveKindDraft,
  minimumTierAfterVariableOperation,
  modulesUsedByCommand,
  replaceCurrencyTokenAt,
  switchTextCommandKind,
  type CommandDraft,
  type CurrencyTemplateField,
  type CurrencyTokenTarget,
} from "./editor-state";
import { commandListReply, TEXT_COMMAND_DEFAULT_TEXTS, TEXT_COMMAND_DEFAULT_USAGE_TEXT } from "../contracts/chat-defaults";
import { statusForTier, validCommandName } from "../domain";
import { invalidTemplateParameters, renderTemplate, templateVariableNames, unknownTemplateVariables, worstCaseTemplateLength, type PanelTemplateWarning, type TemplateVariable } from "../contract";
import { effectivePanelTemplateVariables, panelTemplateOptions, registeredModuleTemplateGroup } from "../../../dashboard/ui";
import { createTextCommand, deleteTextCommand, loadTextCommandData, loadRegisteredTemplateVariables, lookupTextGames, saveTextCommand, searchTextGames, setTextCommandEnabled, textBlockNamesForPicker, type TextCommandChannelVariable } from "./service";
import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useChannelSettings, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import type { TextCommandPanelData } from "./service";
import { textCommandsTexts } from "./locale";
import { convertLeadingSlashCommand, parseLeadingSlashCommand, SLASH_COMMAND_NAMES } from "./slash-command";
import { templateTextLength } from "../../../contracts/template-text-length";
import type { ChatOutputTarget } from "../../../contracts/values";
import type { ModuleRegisteredTemplateVariable } from "../../contract";
import { formatCharacterCount } from "../../../dashboard/ui/text-length";

const normalizeCommandName = (name: string): string => name.trim().replace(/^!/u, "").toLowerCase();

const updateCommandCache = (current: unknown, command: TextCommand, previousName?: string): TextCommandPanelData => {
  const data = typeof current === "object" && current !== null ? current as Partial<TextCommandPanelData> : {};
  const commands = Array.isArray(data.commands) ? data.commands : [];
  const variables = Array.isArray(data.variables) ? data.variables : [];
  return {
    commands: [...commands.filter((item) => item.name !== previousName && item.name !== command.name), command],
    variables,
  };
};

const removeCommandFromCache = (current: unknown, name: string): TextCommandPanelData => {
  const data = typeof current === "object" && current !== null ? current as Partial<TextCommandPanelData> : {};
  const commands = Array.isArray(data.commands) ? data.commands : [];
  const variables = Array.isArray(data.variables) ? data.variables : [];
  return { commands: commands.filter((item) => item.name !== name), variables };
};

const requireCommandRevision = (revision: number | null): number => {
  if (revision === null) throw new Error("command_revision_missing");
  return revision;
};

const draftTimeoutAction = (timeoutAction: TextCommand["timeoutAction"] | undefined): CommandDraft["timeoutAction"] => {
  if (timeoutAction === null || timeoutAction === undefined) return null;
  return { ...timeoutAction, reason: timeoutAction.reason ?? "" };
};

const draftFromCommand = (command: TextCommand): CommandDraft => ({
  name: command.name,
  enabled: command.enabled,
  text: command.text,
  usageText: command.usageText ?? (command.kind === "shoutout" ? TEXT_COMMAND_DEFAULT_USAGE_TEXT : ""),
  kind: command.kind,
  minimumTier: command.minimumTier,
  cooldownSeconds: command.cooldownSeconds,
  aliases: [...command.aliases],
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  games: [...(command.games ?? [])],
  responseType: command.responseType,
  chatTarget: command.chatTarget,
  variableAction: command.kind === "text" || command.kind === "timeout"
    ? command.variableAction === null ? null : { ...command.variableAction }
    : null,
  timeoutAction: command.kind === "timeout"
    ? draftTimeoutAction(command.timeoutAction) ?? { minSeconds: 120, maxSeconds: 120, fallbackText: "", reason: "" }
    : null,
  kindDrafts: {
    [command.kind]: {
      text: command.text,
      usageText: command.usageText ?? (command.kind === "shoutout" ? TEXT_COMMAND_DEFAULT_USAGE_TEXT : ""),
      variableAction: command.kind === "text" || command.kind === "timeout"
        ? command.variableAction === null ? null : { ...command.variableAction }
        : null,
      timeoutAction: command.kind === "timeout"
        ? draftTimeoutAction(command.timeoutAction) ?? { minSeconds: 120, maxSeconds: 120, fallbackText: "", reason: "" }
        : null,
    },
  },
});

const newCommandDraft = (): CommandDraft => ({
  name: "",
  enabled: true,
  text: "",
  usageText: "",
  kind: "text",
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  games: [],
  responseType: "say",
  chatTarget: null,
  variableAction: null,
  timeoutAction: null,
  kindDrafts: { text: { text: "", usageText: "", variableAction: null, timeoutAction: null } },
});

type CommandTemplateField = "text" | "usageText" | "timeoutFallbackText";

const templateFieldsForKind = (kind: TextCommandKind, channelVariables: readonly TextCommandChannelVariable[], timeoutEnabled: boolean): Readonly<Record<string, readonly TemplateVariable[]>> => {
  const fields = TEXT_COMMAND_TEMPLATE_FIELDS[kind] as Readonly<Record<string, readonly TemplateVariable[]>>;
  const effective = effectivePanelTemplateVariables("chat_command", [], channelVariables);
  const timeoutVariables = timeoutEnabled ? TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES : [];
  const result = Object.fromEntries(Object.keys(fields).map((key) => [
    key,
    key === "text" ? [...effective, ...timeoutVariables] : effective,
  ]));
  return timeoutEnabled
    ? { ...result, timeoutFallbackText: [...effective, ...timeoutVariables] }
    : result;
};

const validCommandVariableAction = (
  variable: CommandDraft["variableAction"],
  channelVariables: readonly TextCommandChannelVariable[],
): boolean => variable === null || (channelVariables.some((entry) => entry.name === variable.name) && (
  variable.operation === "add" || variable.operation === "subtract"
    ? variable.amount !== null && variable.amount >= 1 && variable.amount <= 1000
    : variable.operation === "set_argument"
      ? variable.amount === 0
      : variable.amount !== null && variable.amount >= -999999999 && variable.amount <= 999999999
));

const commandFieldPaths = {
  name: "name",
  aliases: "aliases",
  kind: "kind",
  text: "text",
  usageText: "usageText",
  minimumTier: "minimumTier",
  cooldownSeconds: "cooldownSeconds",
  userCooldownSeconds: "userCooldownSeconds",
  streamCondition: "streamCondition",
  games: "games",
  responseType: "responseType",
  chatTarget: "chatTarget",
  variableAction: "variableAction",
  "variableAction.name": "variableAction",
  "variableAction.amount": "variableAction",
  timeoutAction: "timeoutAction",
  "timeoutAction.minSeconds": "timeoutAction",
  "timeoutAction.maxSeconds": "timeoutAction",
  "timeoutAction.fallbackText": "timeoutFallbackText",
  "timeoutAction.reason": "timeoutReason",
} as const;

const currencyCodes = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY"] as const;
const commandDraftIsValid = (draft: CommandDraft, channelVariables: readonly TextCommandChannelVariable[]): boolean => {
  const name = normalizeCommandName(draft.name);
  const timeout = draft.timeoutAction;
  const variable = draft.variableAction;
  const validVariable = validCommandVariableAction(variable, channelVariables);
  const validTimeout = draft.kind === "timeout"
    ? timeout !== null && typeof timeout.minSeconds === "number" && Number.isInteger(timeout.minSeconds) &&
      typeof timeout.maxSeconds === "number" && Number.isInteger(timeout.maxSeconds) && timeout.minSeconds >= 1 &&
      timeout.minSeconds <= timeout.maxSeconds && timeout.maxSeconds <= MODERATION_TIMEOUT_MAX_SECONDS &&
      templateTextLength(timeout.fallbackText) <= 500 && templateTextLength(timeout.reason) <= 500
    : timeout === null;
  const responseRequired = draft.kind !== "list" && draft.kind !== "timeout" && variable === null && draft.text.trim().length === 0;
  return validCommandName(name) && draft.aliases.every(validCommandName) && !draft.aliases.includes(name) && draft.aliases.length <= TEXT_COMMAND_MAX_ALIASES &&
    typeof draft.cooldownSeconds === "number" && Number.isInteger(draft.cooldownSeconds) && draft.cooldownSeconds >= 0 && draft.cooldownSeconds <= 86400 &&
    typeof draft.userCooldownSeconds === "number" && Number.isInteger(draft.userCooldownSeconds) && draft.userCooldownSeconds >= 0 && draft.userCooldownSeconds <= 86400 &&
    validVariable && validTimeout && !responseRequired && templateTextLength(draft.text) <= 500 && (draft.kind === "list" || templateTextLength(draft.usageText) <= 500);
};

const tierDescription = (tier: TextCommandMinimumTier, labels: ReturnType<typeof textCommandsTexts>): string => {
  const included = statusForTier[tier].map((status) => labels.tierSubjects[status]);
  return labels.tierDescription(tier, included);
};

const relativeTime = (value: string | null, labels: ReturnType<typeof textCommandsTexts>): string => {
  if (value === null) return labels.never;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return labels.never;
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return labels.secondsAgo(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return labels.minutesAgo(minutes);
  return labels.hoursAgo(Math.round(minutes / 60));
};

interface TextCommandEditorProperties {
  channelId: string;
  channelDefaultChatTarget?: ChatOutputTarget;
  language?: DashboardLanguage | undefined;
  registeredVariables: readonly ModuleRegisteredTemplateVariable[];
  registeredVariablesLoaded: boolean;
  registeredVariablesPending: boolean;
  registeredVariablesRefreshError: boolean;
  onRetryRegisteredVariables: () => void;
  initial: CommandDraft;
  command: TextCommand | null;
  commands: readonly TextCommand[];
  channelVariables: readonly TextCommandChannelVariable[];
  canManageContent: boolean;
  canOperate: boolean;
  botIsModerator: boolean | null;
  onClose: () => void;
  onGuardChange: (guard: ((proceed: () => void, cancel?: () => void) => void) | null) => void;
  onRefresh: (force?: boolean) => Promise<TextCommand[]>;
  /** Called in the same step as the committed cache write; a no-op if the selection moved on since. */
  onSaved: (token: number, name: string, preserveEditor?: boolean) => void;
  /** Current editor generation; capture it before a mutation starts. */
  generation: () => number;
  onWrite: <Value>(
    baselineRevision: number | null,
    write: (baselineRevision: number | null) => Promise<Value>,
    updateCache: (current: unknown, result: Value) => unknown,
  ) => Promise<Value>;
  onDeleted: (token: number) => void;
  onOpenTestArea?: (moduleId: "text_commands" | "faq", entryId: string) => void;
}

const TextCommandEditor = ({ channelId, channelDefaultChatTarget, language, registeredVariables, registeredVariablesLoaded, registeredVariablesPending, registeredVariablesRefreshError, onRetryRegisteredVariables, initial, command, commands, channelVariables, canManageContent, canOperate, botIsModerator, onClose, onGuardChange, onRefresh, onSaved, generation, onWrite, onDeleted, onOpenTestArea }: TextCommandEditorProperties): ReactElement => {
  const labels = useMemo(() => textCommandsTexts(language), [language]);
  const searchGames = useCallback((query: string) => searchTextGames(channelId, query), [channelId]);
  const lookupGames = useCallback((ids: readonly string[]) => lookupTextGames(channelId, ids), [channelId]);
  const resolvedLanguage = language ?? dashboardLanguage();
  const isCreate = command === null;
  const { value: draft, setValue, dirty: draftDirty, reset, accept } = useDraft<CommandDraft>(initial, isCreate);
  const [pendingAliases, setPendingAliases] = useState("");
  const [selectedCurrencyTokenId, setSelectedCurrencyTokenId] = useState<string | null>(null);
  const draftRevision = useRef(command?.revision ?? null);
  const observedCommandRevision = useRef(command?.revision ?? null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<{ field: "name" | "aliases"; message: string; invalidAlias?: string } | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [saveError, setSaveError] = useState<string | undefined>();
  const [concurrentConflict, setConcurrentConflict] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteWhenGuardCloses, setDeleteWhenGuardCloses] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const editorRef = useRef<HTMLDivElement>(null);
  const [serverWarnings, setServerWarnings] = useState<readonly PanelTemplateWarning[]>([]);
  const [minimumTierExplicit, setMinimumTierExplicit] = useState(false);
  const dirty = draftDirty || pendingAliases.length > 0;
  useEffect(() => {
    if (canManageContent || command === null || observedCommandRevision.current === command.revision) return;
    observedCommandRevision.current = command.revision;

    const pendingEnabled = draftDirty && draft.enabled !== command.enabled ? draft.enabled : null;
    const refreshedDraft = draftFromCommand(command);
    draftRevision.current = command.revision;
    accept(refreshedDraft);
    if (pendingEnabled !== null) setValue({ ...refreshedDraft, enabled: pendingEnabled });
  }, [accept, canManageContent, command, draft.enabled, draftDirty, setValue]);
  const currencyTemplates: { field: CurrencyTemplateField; value: string }[] = draft.kind === "list"
    ? []
    : [
      { field: "text", value: draft.text },
      ...(draft.kind === "shoutout" ? [{ field: "usageText" as const, value: draft.usageText }] : []),
      ...(draft.kind === "timeout" && draft.timeoutAction !== null ? [
        { field: "timeoutFallbackText" as const, value: draft.timeoutAction.fallbackText },
        { field: "timeoutReason" as const, value: draft.timeoutAction.reason },
      ] : []),
    ];
  const currencyTargets = currencyTokenTargets(currencyTemplates);
  const selectedCurrencyTarget = currencyTargets.find(({ id }) => id === selectedCurrencyTokenId) ?? currencyTargets[0];
  const currencyPairForTemplate = (field: CurrencyTemplateField): { from: string; to: string } => {
    const target = selectedCurrencyTarget?.field === field
      ? selectedCurrencyTarget
      : currencyTargets.find((candidate) => candidate.field === field);
    return target === undefined ? { from: "USD", to: "EUR" } : { from: target.from, to: target.to };
  };
  const hasCurrencyToken = currencyTargets.length > 0;
  const libraryBlocks = textBlockNamesForPicker(registeredVariables);
  const blockVariables: TemplateVariable[] = libraryBlocks.map((name) => ({ name, group: "channel", sample: name, maxLength: 500 }));
  const baseTemplateFields = templateFieldsForKind(draft.kind, channelVariables, draft.timeoutAction !== null);
  const registeredTemplateDeclarations = (field: string): readonly TemplateVariable[] => registeredVariables.filter((variable) =>
    !variable.isTextBlock && variable.name.includes(".") &&
    (draft.timeoutAction !== null && (field === "text" || field === "timeoutFallbackText") || !variable.name.startsWith("timeout.")) &&
    (variable.contexts?.includes("chat_command") ?? true));
  const variableAction = draft.variableAction;
  const templateVariables = (field: CommandTemplateField) => [
    ...panelTemplateOptions("chat_command", [], channelVariables, resolvedLanguage),
    ...registeredVariables.filter((variable) => variable.isTextBlock).map((variable) => ({
      name: variable.name,
      label: variable.name,
      description: labels.textBlockDescription,
      sample: variable.sample,
      group: variable.group ?? "channel" as const,
      kind: "module" as const,
      isTextBlock: true,
    })),
    ...registeredVariables.filter((variable) => !variable.isTextBlock && variable.name.includes(".") &&
      (draft.timeoutAction !== null && (field === "text" || field === "timeoutFallbackText") || !variable.name.startsWith("timeout.")) &&
      (variable.contexts?.includes("chat_command") ?? true)).map((variable) => {
      const pickerCopy = variable.picker?.[resolvedLanguage];
      const sourceGroup = registeredModuleTemplateGroup(variable, resolvedLanguage);
      return {
        name: variable.name,
        label: pickerCopy?.label ?? variable.name,
        description: pickerCopy?.description ?? variable.name,
        sample: variable.sample,
        ...(pickerCopy?.sample === undefined ? {} : { pickerSample: pickerCopy.sample }),
        group: variable.group ?? "channel" as const,
        kind: "module" as const,
        ...(sourceGroup === undefined ? {} : { sourceGroup }),
        ...(variable.external === undefined ? {} : { external: variable.external }),
        ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
        ...(variable.parameters === "currency_pair" ? { parameter: { value: `${currencyPairForTemplate(field).from} ${currencyPairForTemplate(field).to}` } } : {}),
      };
    }),
  ];
  const templateFields = Object.fromEntries(Object.entries(baseTemplateFields)
    .map(([field, variables]) => [field, [...variables, ...registeredTemplateDeclarations(field), ...blockVariables]]));
  const templateValue = (field: CommandTemplateField): string => field === "timeoutFallbackText"
    ? draft.timeoutAction?.fallbackText ?? ""
    : draft[field];
  const previewTemplate = (field: CommandTemplateField, template = templateValue(field)): string => {
    const variables = templateVariables(field);
    const values = Object.fromEntries(variables.map((variable) => [variable.name, variable.sample]));
    const declarations = templateFields[field] ?? [];
    const parameterValues = Object.fromEntries(declarations
      .filter((variable) => variable.parameters !== undefined)
      .map((variable) => [variable.name, () => variable.sample]));
    return renderTemplate(template, values, parameterValues, declarations);
  };
  const slashInput = parseLeadingSlashCommand(draft.text);
  const convertedDraft = slashInput.status === "valid"
    ? convertLeadingSlashCommand(draft, slashInput, {
      text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout,
      usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT,
    })
    : draft;
  const validationDraft = convertedDraft;
  const validationTemplateFields = Object.fromEntries(Object.entries(templateFieldsForKind(
    validationDraft.kind,
    channelVariables,
    validationDraft.timeoutAction !== null,
  ))
    .map(([field, variables]) => [field, [...variables, ...registeredTemplateDeclarations(field), ...blockVariables]]));
  const validationTemplateValue = (field: string): string => field === "timeoutFallbackText"
    ? validationDraft.timeoutAction?.fallbackText ?? ""
    : validationDraft[field as "text" | "usageText"];
  const validationResponseInvalid = Object.keys(validationTemplateFields).some((field) => {
    const value = validationTemplateValue(field);
    const optionalTimeoutText = validationDraft.kind === "timeout" && (field === "text" || field === "timeoutFallbackText");
    return (value.trim().length === 0 && !optionalTimeoutText && !(field === "text" && validationDraft.variableAction !== null && validationDraft.timeoutAction === null) && field !== "usageText") || templateTextLength(value) > 500;
  });
  const normalizedName = normalizeCommandName(draft.name);
  const sameNameAlias = draft.aliases.includes(normalizedName);
  const invalidAlias = draft.aliases.find((alias) => !validCommandName(alias));
  const nameError = fieldError?.field === "name" ? fieldError.message : serverFieldErrors.name ?? (attemptedSave && normalizedName.length === 0 ? labels.nameMissing : attemptedSave && !validCommandName(normalizedName) ? labels.nameInvalid : undefined);
  const pendingAliasError = attemptedSave && pendingAliases.length > 0 ? labels.aliasPendingInvalid : undefined;
  const aliasesError = fieldError?.field === "aliases" ? fieldError.message : serverFieldErrors.aliases ?? pendingAliasError ?? (sameNameAlias ? labels.aliasIsName : invalidAlias !== undefined ? labels.aliasInvalid(invalidAlias) : attemptedSave && draft.aliases.length > TEXT_COMMAND_MAX_ALIASES ? labels.chipsInputMessages.atLimitHint : undefined);
  const cooldownInvalid = draft.cooldownSeconds === "" || !Number.isInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 0 || draft.cooldownSeconds > 86400;
  const userCooldownInvalid = draft.userCooldownSeconds === "" || !Number.isInteger(draft.userCooldownSeconds) || draft.userCooldownSeconds < 0 || draft.userCooldownSeconds > 86400;
  const templateFieldNames = Object.keys(templateFields) as CommandTemplateField[];
  const responseFieldError = serverFieldErrors.text ?? (slashInput.status === "invalid"
    ? labels.slashSyntaxError(slashInput.command)
    : templateTextLength(validationDraft.text) > 500
    ? labels.fieldTooLong
    : attemptedSave && validationDraft.kind !== "timeout" && validationDraft.kind !== "list" && validationDraft.variableAction === null && validationDraft.text.trim().length === 0
      ? labels.responseMissing
      : undefined);
  const timeoutRangeInvalid = validationDraft.kind === "timeout" && (validationDraft.timeoutAction === null ||
    typeof validationDraft.timeoutAction.minSeconds !== "number" || !Number.isInteger(validationDraft.timeoutAction.minSeconds) || validationDraft.timeoutAction.minSeconds < 1 ||
    typeof validationDraft.timeoutAction.maxSeconds !== "number" || !Number.isInteger(validationDraft.timeoutAction.maxSeconds) ||
    validationDraft.timeoutAction.minSeconds > validationDraft.timeoutAction.maxSeconds || validationDraft.timeoutAction.maxSeconds > MODERATION_TIMEOUT_MAX_SECONDS);
  const timeoutReasonError = serverFieldErrors.timeoutReason ?? (validationDraft.timeoutAction !== null && templateTextLength(validationDraft.timeoutAction.reason) > 500 ? labels.fieldTooLong : undefined);
  const timeoutFallbackError = serverFieldErrors.timeoutFallbackText ?? (validationDraft.timeoutAction !== null && templateTextLength(validationDraft.timeoutAction.fallbackText) > 500 ? labels.fieldTooLong : undefined);
  const variableActionInvalid = !validCommandVariableAction(validationDraft.variableAction, channelVariables);
  const variableActionAmountInvalid = validationDraft.variableAction !== null && (
    validationDraft.variableAction.operation === "set_argument"
      ? validationDraft.variableAction.amount !== 0
      : validationDraft.variableAction.amount === null || !Number.isInteger(validationDraft.variableAction.amount) ||
        (validationDraft.variableAction.operation === "add" || validationDraft.variableAction.operation === "subtract"
          ? validationDraft.variableAction.amount < 1 || validationDraft.variableAction.amount > 1000
          : validationDraft.variableAction.amount < -999999999 || validationDraft.variableAction.amount > 999999999)
  );
  const variableActionError = serverFieldErrors.variableAction ?? (attemptedSave && variableActionInvalid ? labels.variableActionInvalid : undefined);
  const valid = canManageContent
    ? slashInput.status !== "invalid" && !validationResponseInvalid && pendingAliases.length === 0 && Object.keys(serverFieldErrors).length === 0 && fieldError === null &&
      (validationDraft.variableAction === null || validationDraft.kind === "text" || validationDraft.kind === "timeout") &&
      commandDraftIsValid(validationDraft, channelVariables)
    : canOperate && command !== null && pendingAliases.length === 0;
  useEffect(() => {
    if (validationAttempt === 0 || valid) return;
    const invalidField = editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalidField === undefined || invalidField === null) return;
    const focusableSelector = "input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex='-1']):not(:disabled)";
    const focusTarget = invalidField.matches(focusableSelector)
      ? invalidField
      : invalidField.querySelector<HTMLElement>(focusableSelector);
    if (focusTarget === null) return;
    for (let details = focusTarget.closest("details"); details !== null; details = details.parentElement?.closest("details") ?? null) {
      details.open = true;
    }
    if (typeof focusTarget.scrollIntoView === "function") focusTarget.scrollIntoView({ block: "center" });
    focusTarget.focus();
  }, [valid, validationAttempt]);
  const localWarnings = templateFieldNames.flatMap((field) => {
    const variables = templateFields[field] ?? [];
    const value = templateValue(field);
    const unknown = unknownTemplateVariables(value, variables);
    const worstCaseLength = worstCaseTemplateLength(value, variables);
    return [
      ...(unknown.length === 0 ? [] : [labels.warningLabel({ field, code: "unknown_template_variables", unknownVariables: unknown })]),
      ...invalidTemplateParameters(value, variables).map((token) => labels.warningLabel({ field, code: "template_parameters_invalid", invalidVariables: [token] })),
      ...(worstCaseLength > 500 ? [labels.warningLabel({ field, code: "template_worst_case_too_long", worstCaseLength })] : []),
    ];
  });
  const usesExternalVariable = templateFieldNames.some((field) => {
    const names = new Set(templateVariableNames(templateValue(field)));
    return (templateFields[field] ?? []).some((variable) => variable.external === true && names.has(variable.name));
  });
  const passesArgumentsToEveryone = draft.minimumTier === "everyone" && templateFieldNames.some((field) => templateVariableNames(templateValue(field)).includes("args"));
  const warnings = [...serverWarnings.map(labels.warningLabel), ...localWarnings,
    ...(usesExternalVariable && Number(draft.cooldownSeconds) < 5 ? [labels.externalCooldownWarning] : []),
    ...(passesArgumentsToEveryone ? [labels.argsEveryoneWarning] : []),
  ];
  const tierOptions = TEXT_COMMAND_MINIMUM_TIERS.map((tier) => ({
    value: tier,
    label: labels.tierLabels[tier],
    inclusion: tierDescription(tier, labels),
  }));
  const kindOptions = TEXT_COMMAND_KINDS.map((kind) => ({ value: kind, label: labels.kindLabels[kind] }));
  const announcementWarning = draft.responseType === "announcement" && botIsModerator === false ? labels.announcementWarning : undefined;
  const slashSuggestions = slashInput.status === "suggestions"
    ? SLASH_COMMAND_NAMES.filter((name) => name.startsWith(slashInput.fragment))
    : slashInput.status === "invalid" ? [slashInput.command] : [];
  const slashEffect = slashInput.status !== "valid" ? null
    : slashInput.command === "timeout"
      ? labels.slashTimeoutEffect(slashInput.minSeconds ?? 0, slashInput.maxSeconds ?? 0)
      : slashInput.command === "announce" ? labels.slashAnnouncementEffect : labels.slashShoutoutEffect;
  const listPreview = commandListReply(commands.filter((item) => item.enabled && item.name !== command?.name).map((item) => item.name));
  const setDraftField = <Key extends keyof CommandDraft>(key: Key, value: CommandDraft[Key]): void => {
    if (key === "minimumTier") setMinimumTierExplicit(true);
    setValue((current) => ({ ...current, [key]: value }));
    setSaved(false); setConcurrentConflict(false); setReloadError(false);
    setSaveError(undefined);
    if (key === "name" || key === "aliases") setFieldError(null);
    const fieldsToClear = key === "timeoutAction"
      ? ["timeoutAction", "timeoutFallbackText", "timeoutReason"]
      : key === "variableAction" ? ["variableAction"] : [key];
    setServerFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !fieldsToClear.includes(field))));
  };
  const variableActionEditor = draft.kind === "text" || draft.kind === "timeout" ? <SwitchSection
    id="command-variable-action"
    title={labels.variableAction}
    hint={variableAction === null ? labels.variableSelectHint : labels.variableOperationHelp[variableAction.operation]}
    checked={variableAction !== null}
    disabled={!canManageContent || pending}
    onChange={(enabled) => {
      setDraftField("variableAction", enabled
        ? { name: channelVariables[0]?.name ?? "", operation: "add", amount: 1 }
        : null);
    }}
  >
    {variableAction === null ? null : <div className="command-variable-action" data-testid="command-variable-action-slot">
      <Select
        id="command-variable-name"
        label={labels.variableSelect}
        hint={labels.variableSelectHint}
        {...(variableActionError === undefined ? {} : { error: variableActionError })}
        value={variableAction.name || null}
        placeholder={labels.variableNone}
        options={channelVariables.map((variable) => ({ value: variable.name, label: variable.name, description: `${String(variable.value)}${variable.description.length > 0 ? ` · ${variable.description}` : ""}` }))}
        disabled={!canManageContent || pending || channelVariables.length === 0}
        onChange={(name) => { if (name !== null) setDraftField("variableAction", { ...variableAction, name }); }}
      />
      <FieldPair>
        <SegmentChoice
          label={labels.variableAction}
          hint={labels.variableOperationHelp[variableAction.operation]}
          value={variableAction.operation}
          options={(["add", "subtract", "set", "set_argument"] as const).map((operation) => ({ value: operation, label: labels.variableOperations[operation], ...(operation === "set_argument" ? { compactLabel: "Arg." } : {}) }))}
          disabled={!canManageContent || pending}
          onChange={(operation) => {
            const nextOperation = operation;
            setValue((current) => ({
              ...current,
              variableAction: {
                ...variableAction,
                operation: nextOperation,
                amount: nextOperation === "set_argument" ? 0 : nextOperation === "add" || nextOperation === "subtract" ? (variableAction.amount && variableAction.amount > 0 ? variableAction.amount : 1) : variableAction.amount ?? 0,
              },
              minimumTier: minimumTierAfterVariableOperation(current.minimumTier, nextOperation, minimumTierExplicit),
            }));
            setSaved(false); setConcurrentConflict(false); setReloadError(false);
          }}
        />
        <div aria-hidden={variableAction.operation === "set_argument"} style={{ visibility: variableAction.operation === "set_argument" ? "hidden" : "visible" }}>
          <UnitInput
            id="command-variable-amount"
            label={labels.variableAmount}
            hint={labels.variableOperationHelp[variableAction.operation]}
            min={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1 : -999999999}
            max={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1000 : 999999999}
            step={1}
            value={variableAction.amount ?? ""}
            disabled={!canManageContent || pending || variableAction.operation === "set_argument"}
            {...(attemptedSave && variableActionAmountInvalid ? { error: labels.variableActionInvalid } : {})}
            onChange={(amount) => setDraftField("variableAction", { ...variableAction, amount: amount === "" ? null : amount })}
          />
        </div>
      </FieldPair>
      <p className={channelVariables.length === 0 && variableActionError !== undefined ? "form-error" : "muted"} role={channelVariables.length === 0 && variableActionError !== undefined ? "alert" : undefined} style={{ minHeight: "var(--s6)", margin: 0 }}>
        {channelVariables.length === 0 ? <>{variableActionError === undefined ? labels.variableNone : `× ${variableActionError} `}<a href={`/channels/${encodeURIComponent(channelId)}/variables`}>{labels.createVariable}</a></> : ""}
      </p>
      <p className="form-warning" role="note" style={{ minHeight: "var(--s6)", margin: 0 }}>{variableAction.operation === "set_argument" && draft.minimumTier === "everyone" ? labels.variableEveryoneWarning : ""}</p>
      <p className="muted" style={{ minHeight: "var(--s6)", margin: 0 }}>{draft.kind === "text" && draft.text.trim().length === 0 ? labels.variableSilentHint : ""}</p>
    </div>}
  </SwitchSection> : null;
  const responseTypeEditor = draft.kind === "shoutout" ? null : <SegmentChoice
    label={labels.responseType}
    hint={labels.responseTypeHints[draft.responseType]}
    value={draft.responseType}
    options={( ["say", "reply", "announcement"] as const).map((value) => ({ value, label: labels.responseTypeLabels[value] }))}
    {...(announcementWarning === undefined ? {} : { warning: announcementWarning })}
    {...(serverFieldErrors.responseType === undefined ? {} : { error: serverFieldErrors.responseType })}
    reserveError
    disabled={!canManageContent || pending}
    onChange={(value) => { setDraftField("responseType", value); }}
  />;
  const chatTargetEditor = <ChatTargetField
    label={labels.chatTarget}
    language={resolvedLanguage}
    value={draft.chatTarget}
    {...(channelDefaultChatTarget === undefined ? {} : { effectiveDefault: channelDefaultChatTarget })}
    allowed={["all_chats", "source_only", "channel_default", "where_asked"]}
    {...(serverFieldErrors.chatTarget === undefined ? {} : { error: serverFieldErrors.chatTarget })}
    reserveError
    disabled={!canManageContent || pending}
    onChange={(chatTarget) => { setDraftField("chatTarget", chatTarget); }}
  />;

  const completeSwitchRef = useRef<() => boolean>(() => false);
  const deleteAfterSaveRef = useRef(false);
  const saveDraft = useCallback(async (): Promise<string | null> => {
    setAttemptedSave(true);
    setValidationAttempt((attempt) => attempt + 1);
    if (pendingAliases.length > 0) return labels.aliasPendingInvalid;
    const operatorToggle = !canManageContent;
    if (operatorToggle) {
      if (!canOperate || command === null) {
        setSaveError(labels.managementLocked);
        return labels.managementLocked;
      }
      const baseline = draftFromCommand(command);
      if (draft.enabled === baseline.enabled) return null;
    }
    const parsedSlashInput = operatorToggle ? { status: "none" as const } : parseLeadingSlashCommand(draft.text);
    if (parsedSlashInput.status === "invalid") return labels.invalid;
    const convertedDraft = parsedSlashInput.status === "valid"
      ? convertLeadingSlashCommand(draft, parsedSlashInput, {
        text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout,
        usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT,
      })
      : draft;
    const savedDraft = keepOnlyActiveKindDraft(convertedDraft);
    if (!operatorToggle && !commandDraftIsValid(savedDraft, channelVariables)) return labels.invalid;
    const payload = {
      name: normalizeCommandName(savedDraft.name),
      enabled: savedDraft.enabled,
      text: savedDraft.kind === "list" ? "" : savedDraft.text,
      kind: savedDraft.kind,
      ...(savedDraft.kind === "list" ? {} : { usageText: savedDraft.usageText }),
      minimumTier: savedDraft.minimumTier,
      cooldownSeconds: savedDraft.cooldownSeconds as number,
      aliases: savedDraft.aliases,
      userCooldownSeconds: savedDraft.userCooldownSeconds as number,
      streamCondition: savedDraft.streamCondition,
      games: savedDraft.games,
      responseType: savedDraft.responseType,
      chatTarget: savedDraft.chatTarget,
      variableAction: savedDraft.kind === "text" || savedDraft.kind === "timeout" ? savedDraft.variableAction : null,
      timeoutAction: savedDraft.kind !== "timeout" || savedDraft.timeoutAction === null ? null : {
        minSeconds: typeof savedDraft.timeoutAction.minSeconds === "number" ? savedDraft.timeoutAction.minSeconds : 0,
        maxSeconds: typeof savedDraft.timeoutAction.maxSeconds === "number" ? savedDraft.timeoutAction.maxSeconds : 0,
        fallbackText: savedDraft.timeoutAction.fallbackText,
        reason: savedDraft.timeoutAction.reason,
      },
    };
    setPending(true); setDeleteError(undefined); setFieldError(null); setServerFieldErrors({}); setSaveError(undefined); setConcurrentConflict(false); setReloadError(false); setSaved(false);
    try {
      const baselineRevision = isCreate ? null : operatorToggle ? command.revision : draftRevision.current;
      const token = generation();
      const result = await onWrite(
        baselineRevision,
        (revision) => command === null
          ? createTextCommand(channelId, payload)
          : operatorToggle
            ? setTextCommandEnabled(channelId, command.name, requireCommandRevision(revision), savedDraft.enabled)
            : saveTextCommand(channelId, { oldName: command.name, revision: requireCommandRevision(revision), ...payload }),
        (current, mutationResult) => {
          const next = updateCommandCache(current, mutationResult.command, command?.name);
          const continueDeleteAfterSave = deleteAfterSaveRef.current;
          const completedSwitch = token === generation() && completeSwitchRef.current();
          if (!completedSwitch || continueDeleteAfterSave || isCreate) {
            onSaved(token, mutationResult.command.name, continueDeleteAfterSave);
          }
          return next;
        },
      );
      draftRevision.current = result.command.revision;
      accept(operatorToggle ? draftFromCommand(result.command) : { ...savedDraft, ...payload, name: payload.name });
      setServerWarnings(result.warnings);
      await onRefresh();
      setSaved(true);
      return null;
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "command_changed_concurrently") {
        setConcurrentConflict(true);
        return labels.conflictMessage;
      }
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "command_already_exists") {
        setFieldError({ field: "name", message: labels.nameExists });
        return labels.nameExists;
      }
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "command_alias_conflict") {
        const details = caught.details as { conflict?: { field?: string; trigger?: string; command?: string } } | null;
        const conflict = details?.conflict;
        if (conflict !== undefined && typeof conflict.trigger === "string" && typeof conflict.command === "string") {
          if (conflict.field === "name") {
            const message = labels.nameAliasConflict(conflict.trigger, conflict.command);
            setFieldError({ field: "name", message });
            return message;
          }
          if (conflict.field === "aliases") {
            const message = labels.aliasConflict(conflict.trigger, conflict.command);
            setFieldError({ field: "aliases", message, invalidAlias: normalizeCommandName(conflict.trigger) });
            return message;
          }
        }
      }
      const mappedErrors = mapServerFieldErrors(caught, commandFieldPaths, (reasonCode) => serverFieldErrorText(reasonCode, resolvedLanguage));
      if (Object.keys(mappedErrors).length > 0) {
        setServerFieldErrors(mappedErrors);
        return labels.invalid;
      }
      setSaveError(labels.saveError);
      notify({ tone: "error", message: labels.saveError });
      return labels.saveError;
    } finally { setPending(false); }
  }, [accept, canManageContent, canOperate, channelId, channelVariables, command, draft, generation, isCreate, labels, onRefresh, onSaved, onWrite, pendingAliases, resolvedLanguage, setAttemptedSave, setConcurrentConflict, setFieldError, setPending, setSaved, setServerFieldErrors, setServerWarnings, setValidationAttempt]);

  const discardDraft = (): void => {
    reset(); setPendingAliases(""); setAttemptedSave(false); setSaved(false); setFieldError(null); setDeleteError(undefined);
    setServerFieldErrors({}); setSaveError(undefined); setServerWarnings([]);
  };
  const guard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => { completeSwitchRef.current = guard.completeSwitch; }, [guard.completeSwitch]);
  useEffect(() => {
    if (!deleteWhenGuardCloses || guard.confirmOpen) return;
    const frame = window.requestAnimationFrame(() => {
      setDeleteWhenGuardCloses(false);
      setConfirmingDelete(true);
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [deleteWhenGuardCloses, guard.confirmOpen]);
  useEffect(() => {
    onGuardChange(guard.guardSwitch);
    return () => { onGuardChange(null); };
  }, [guard.guardSwitch, onGuardChange]);

  const setTemplateField = (field: CommandTemplateField, value: string): void => {
    if (field === "timeoutFallbackText") {
      if (draft.timeoutAction !== null) setDraftField("timeoutAction", { ...draft.timeoutAction, fallbackText: value });
      return;
    }
    setDraftField(field, value);
  };

  const setCurrencyPair = (from: string, to: string): void => {
    const target: CurrencyTokenTarget | undefined = selectedCurrencyTarget;
    if (target === undefined) return;
    const replace = (template: string): string => replaceCurrencyTokenAt(template, target.index, from, to);
    if (target.field === "text") setDraftField("text", replace(draft.text));
    else if (target.field === "usageText") setDraftField("usageText", replace(draft.usageText));
    else if (draft.timeoutAction !== null) setDraftField("timeoutAction", {
      ...draft.timeoutAction,
      ...(target.field === "timeoutFallbackText" ? { fallbackText: replace(draft.timeoutAction.fallbackText) } : {}),
      ...(target.field === "timeoutReason" ? { reason: replace(draft.timeoutAction.reason) } : {}),
    });
  };

  const changeKind = (kind: TextCommandKind): void => {
    if (kind === draft.kind) return;
    setValue((current) => switchTextCommandKind(current, kind, isCreate));
    setSaved(false); setConcurrentConflict(false); setReloadError(false);
    setServerFieldErrors({}); setSaveError(undefined);
  };

  const reloadServer = async (): Promise<void> => {
    setReloadError(false);
    const token = generation();
    try {
      const data = await onRefresh(true);
      if (token !== generation()) return;
      const latest = data.find((item) => item.name === command?.name || item.name === normalizedName);
      if (latest === undefined) { onClose(); return; }
      accept(draftFromCommand(latest));
      draftRevision.current = latest.revision;
      setConcurrentConflict(false); setFieldError(null); setDeleteError(undefined); setServerWarnings([]);
    } catch {
      setReloadError(true);
    }
  };

  const remove = async (): Promise<void> => {
    if (command === null) return;
    setDeleting(true); setDeleteError(undefined);
    try {
      const baselineRevision = draftRevision.current;
      const token = generation();
      await onWrite(
        baselineRevision,
        (revision) => deleteTextCommand(channelId, command.name, requireCommandRevision(revision)),
        (current) => {
          const next = removeCommandFromCache(current, command.name);
          onDeleted(token);
          return next;
        },
      );
      setConfirmingDelete(false);
    }
    catch { setDeleteError(labels.deleteError); }
    finally { setDeleting(false); }
  };

  const templateEditor = (field: CommandTemplateField, label: string, hint = labels.responseHint): ReactElement => {
    const value = templateValue(field);
    return <div className="command-template-editor" key={field}>
      <TemplateTextField
        id={`command-${field}`}
        name={field}
        label={field === "text" ? draft.kind === "timeout" ? labels.responseOptional : labels.response : label}
        hint={hint}
        value={value}
        onChange={(next) => { setTemplateField(field, next); }}
        maxLength={500}
        minRows={field === "text" ? 2 : 3}
        variables={templateVariables(field)}
        {...(field === "text" ? {
          preview: () => previewTemplate("text"),
          previewLabel: labels.previewLabel,
          previewSpeaker: labels.previewSpeaker,
        } : {})}
        {...(field === "text" ? { insertVariableLabel: labels.insertVariable } : {})}
        disabled={!canManageContent || pending}
        messages={labels.templateMessages}
        required={field === "text" && draft.kind !== "timeout" && draft.variableAction === null}
        {...(field === "text" && responseFieldError !== undefined ? { error: responseFieldError } : {})}
        {...(field === "usageText" && serverFieldErrors.usageText !== undefined ? { error: serverFieldErrors.usageText } : {})}
        {...(field === "timeoutFallbackText" && timeoutFallbackError !== undefined ? { error: timeoutFallbackError } : {})}
      />
      {field === "text" ? <div className="command-slash-help" aria-live="polite">
        {slashInput.status === "none" ? null : <>
        {slashSuggestions.length > 0 ? <>
          <p className="form-hint">{labels.slashCommandHelp}</p>
          <div className="command-slash-help__options" role="group" aria-label={labels.slashCommandHelp}>
            {slashSuggestions.map((slashCommand) => <button
              key={slashCommand}
              type="button"
              className="command-slash-help__option"
              disabled={!canManageContent || pending}
              onClick={() => {
                const examples = {
                  timeout: "/timeout {user} 120\n",
                  announce: "/announce ",
                  shoutout: "/shoutout {target}\n",
                };
                const leadingDirective = /^\/[^\s]*/u.exec(draft.text)?.[0] ?? "";
                const remainder = draft.text.slice(leadingDirective.length);
                const example = examples[slashCommand];
                const replacement = /^(?:\r?\n)/u.test(remainder) && example.endsWith("\n") ? example.slice(0, -1) : example;
                setTemplateField("text", `${replacement}${remainder}`);
              }}
            >
              <code>{labels.slashCommands[slashCommand].syntax}</code>
              <span>{labels.slashCommands[slashCommand].description}</span>
            </button>)}
          </div>
        </> : null}
        {slashInput.status === "invalid"
          ? <p className="form-error" role="alert">× {labels.slashSyntaxError(slashInput.command)}</p>
          : slashInput.status === "unsupported"
            ? <p className="form-warning" role="status">{labels.slashUnsupportedWarning}</p>
            : slashEffect === null ? null : <p className="form-hint" role="status">{slashEffect}</p>}
        </>}
      </div> : null}
    </div>;
  };

  const registeredVariableStatus = <LoadState
      variant="status-row"
      status={registeredVariablesRefreshError || (!registeredVariablesLoaded && !registeredVariablesPending)
        ? "error"
        : registeredVariablesLoaded ? "success" : "loading"}
      loading={null}
      empty={null}
      error={<p className="muted" role="alert" style={{ height: "var(--s6)", overflow: "hidden", margin: 0, whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{labels.templateVariablesLoadError}</p>}
      queryError={{ message: labels.templateVariablesLoadError, onRetry: onRetryRegisteredVariables }}
      refreshError={registeredVariablesRefreshError}
      className="text-command-variable-load-state"
    >{null}</LoadState>;
  const triggerFields = <>
    <FieldPair>
      <Field
        id="command-name"
        label={labels.name}
        hint={labels.nameHint}
        errorInDescription
        prefix="!"
        normalize={normalizeCommandName}
        maxLength={32}
        countLabel={(count, maximum) => formatCharacterCount(count, maximum, resolvedLanguage)}
        value={draft.name}
        {...(nameError === undefined ? {} : { error: nameError })}
        required
        disabled={!canManageContent || pending}
        onChange={(value) => { setDraftField("name", value); }}
      />
      <ChipsInput
        id="command-aliases"
        label={labels.aliases}
        placeholder={labels.aliasPlaceholder}
        values={draft.aliases}
        onChange={(value) => { setDraftField("aliases", value); }}
        pending={pendingAliases}
        onPendingChange={setPendingAliases}
        stripPrefix="!"
        normalize={normalizeCommandName}
        validate={(alias) => !validCommandName(alias) ? labels.aliasInvalid(alias) : alias === normalizedName ? labels.aliasIsName : null}
        max={TEXT_COMMAND_MAX_ALIASES}
        {...(aliasesError === undefined ? {} : { error: aliasesError })}
        invalidValues={[fieldError?.field === "aliases" ? fieldError.invalidAlias ?? "" : "", ...(sameNameAlias ? [normalizedName] : []), ...(invalidAlias === undefined ? [] : [invalidAlias])].filter(Boolean)}
        removeLabel={labels.aliasRemove}
        messages={labels.chipsInputMessages}
        listLabel={labels.aliasList}
        disabled={!canManageContent || pending}
      />
    </FieldPair>
  </>;

  const sections = [
    {
      id: "settings",
      label: "",
      icon: "tabSettings" as const,
      content: <>
        {draft.kind === "timeout" && draft.timeoutAction !== null ? <div className="command-timeout-action">
          <span className="ui-field__label">{labels.timeoutDuration}</span>
          <TimeoutDurationRangeFields
            idPrefix="command-timeout"
            value={draft.timeoutAction}
            onChange={(range) => {
              const timeoutAction = draft.timeoutAction;
              if (timeoutAction !== null) setDraftField("timeoutAction", { ...timeoutAction, ...range });
            }}
            min={1}
            max={MODERATION_TIMEOUT_MAX_SECONDS}
            minimumLabel={labels.timeoutMinSeconds}
            maximumLabel={labels.timeoutMaxSeconds}
            hint={labels.timeoutRangeHint}
            {...(serverFieldErrors.timeoutAction === undefined && !(attemptedSave && timeoutRangeInvalid) ? {} : { error: serverFieldErrors.timeoutAction ?? labels.timeoutRangeInvalid })}
            disabled={!canManageContent || pending}
          />
        </div> : null}
        {draft.kind === "list"
          ? <ChatPreview label={labels.previewLabel} speaker={labels.previewSpeaker} text={listPreview} countLabel={labels.templateMessages.previewCountLabel(listPreview.length)} />
          : <div className="text-command-response-fields">
            {templateEditor("text", draft.kind === "timeout" ? labels.responseOptional : labels.response)}
          </div>}
        {hasCurrencyToken ? <div className="text-command-currency-slot">
          <Select
            label={labels.currencyToken}
            value={selectedCurrencyTarget?.id ?? null}
            options={currencyTargets.map((target) => {
              const fieldLabel = target.field === "text" ? labels.response
                : target.field === "usageText" ? labels.templateFieldLabels.usageText
                  : target.field === "timeoutFallbackText" ? labels.timeoutFallbackTextOptional : labels.timeoutReason;
              const occurrence = currencyTargets.filter((candidate) => candidate.field === target.field).findIndex((candidate) => candidate.id === target.id) + 1;
              return { value: target.id, label: `${fieldLabel} · ${String(occurrence)}` };
            })}
            disabled={!canManageContent || pending}
            onChange={(id) => { setSelectedCurrencyTokenId(id); }}
          />
          <FieldPair>
            <Select
              label={labels.currencyFrom}
              value={selectedCurrencyTarget?.from ?? "USD"}
              options={currencyCodes.map((code) => ({ value: code, label: code }))}
              disabled={!canManageContent || pending}
              onChange={(from) => { if (from !== null) setCurrencyPair(from, selectedCurrencyTarget?.to ?? "EUR"); }}
            />
            <Select
              label={labels.currencyTo}
              value={selectedCurrencyTarget?.to ?? "EUR"}
              options={currencyCodes.map((code) => ({ value: code, label: code }))}
              disabled={!canManageContent || pending}
              onChange={(to) => { if (to !== null) setCurrencyPair(selectedCurrencyTarget?.from ?? "USD", to); }}
            />
          </FieldPair>
        </div> : null}
        {draft.kind === "timeout" && draft.timeoutAction !== null ? <div className="command-timeout-action">
          {templateEditor("timeoutFallbackText", labels.timeoutFallbackTextOptional)}
          <p className="form-warning text-command-reserved-note" role="note">{botIsModerator === false ? labels.timeoutBotWarning : " "}</p>
          <Field
            id="command-timeout-reason"
            label={labels.timeoutReason}
            hint={labels.timeoutReasonHint}
            value={draft.timeoutAction.reason}
            maxLength={500}
            countLength={templateTextLength}
            {...(timeoutReasonError === undefined ? {} : { error: timeoutReasonError })}
            countLabel={(count, maximum) => formatCharacterCount(count, maximum, resolvedLanguage)}
            disabled={!canManageContent || pending}
            onChange={(reason) => {
              const timeoutAction = draft.timeoutAction;
              if (timeoutAction !== null) setDraftField("timeoutAction", { ...timeoutAction, reason });
            }}
          />
        </div> : null}
      </>,
    },
    {
      id: "advanced",
      label: "",
      icon: "tabAdvanced" as const,
      content: <>
        <Section title={labels.minimumTier} className="text-command-role">
          <RoleThreshold
            label={labels.minimumRole}
            value={draft.minimumTier}
            options={tierOptions}
            disabled={!canManageContent || pending}
            {...(serverFieldErrors.minimumTier === undefined ? {} : { error: serverFieldErrors.minimumTier })}
            onChange={(value) => { setDraftField("minimumTier", value as TextCommandMinimumTier); }}
          />
          {draft.minimumTier === "everyone" ? null : <p className="text-command-reserved-note muted">{labels.tierHelp}</p>}
        </Section>
        <Section title={labels.cooldown} className="text-command-cooldown">
          <UnitInput
            id="command-cooldown"
            label={labels.cooldownField}
            hint={labels.cooldownHint}
            unit="s"
            min={0}
            max={86400}
            step={5}
            value={draft.cooldownSeconds}
            suggestions={[5, 30, 60]}
            {...(serverFieldErrors.cooldownSeconds === undefined && !(attemptedSave && cooldownInvalid) ? {} : { error: serverFieldErrors.cooldownSeconds ?? labels.numberMissing })}
            disabled={!canManageContent || pending}
            onChange={(value) => { setDraftField("cooldownSeconds", value); }}
          />
        </Section>
        <Section title={labels.availability} className="text-command-availability">
          <FieldPair>
            <SegmentChoice
              label={labels.streamCondition}
              hint={labels.streamHints[draft.streamCondition]}
              value={draft.streamCondition}
              {...(serverFieldErrors.streamCondition === undefined ? {} : { error: serverFieldErrors.streamCondition })}
              reserveError
              options={(["any", "online", "offline"] as const).map((value) => ({ value, label: labels.streamLabels[value] }))}
              disabled={!canManageContent || pending}
              onChange={(value) => { setDraftField("streamCondition", value); }}
            />
            <GameMultiSelect
              searchGames={searchGames}
              lookupGames={lookupGames}
              value={draft.games}
              onChange={(games) => { setDraftField("games", games); }}
              messages={{ ...labels.gameMultiSelect, label: labels.gameFilter, hint: labels.gameFilterHint }}
              {...(serverFieldErrors.games === undefined ? {} : { error: serverFieldErrors.games })}
              disabled={!canManageContent || pending}
            />
          </FieldPair>
        </Section>
        <details className="command-usage-advanced">
          <summary>{labels.usageAdvanced}</summary>
          <div className="command-usage-advanced__body">
            <UnitInput
              id="command-user-cooldown"
              label={labels.userCooldown}
              hint={labels.userCooldownHint}
              unit="s"
              min={0}
              max={86400}
              step={5}
              value={draft.userCooldownSeconds}
              suggestions={[0, 60, 300]}
              {...(serverFieldErrors.userCooldownSeconds === undefined && !(attemptedSave && userCooldownInvalid) ? {} : { error: serverFieldErrors.userCooldownSeconds ?? labels.numberMissing })}
              disabled={!canManageContent || pending}
              onChange={(value) => { setDraftField("userCooldownSeconds", value); }}
            />
            {responseTypeEditor === null ? chatTargetEditor : <FieldPair>{responseTypeEditor}{chatTargetEditor}</FieldPair>}
            {draft.kind !== "list" ? templateEditor("usageText", labels.templateFieldLabels.usageText, labels.usageTextHint) : null}
            {draft.kind === "shoutout" ? <p className="muted command-shoutout-hint">{labels.shoutoutCooldownHint}</p> : null}
            {variableActionEditor}
          </div>
        </details>
      </>,
    },
  ];

  const requestDelete = (): void => {
    if (dirty) deleteAfterSaveRef.current = true;
    guard.guardSwitch(() => {
      deleteAfterSaveRef.current = false;
      setDeleteError(undefined);
      setDeleteWhenGuardCloses(true);
    }, () => { deleteAfterSaveRef.current = false; });
  };
  const pageMeta = command === null ? undefined : <span>{labels.lastUsed} {relativeTime(command.lastUsedAt, labels)} · {labels.useCount(command.useCount)}</span>;
  const common = dashboardCommonTexts(resolvedLanguage);
  const testAreaReason = command === null ? labels.testAreaSavedOnly : dirty ? labels.testAreaDirty : "";
  const pageActions = <>
    <div className="editor-test-area-action">
      <Button
        variant="neutral"
        {...(testAreaReason.length === 0 ? {} : { describedBy: "text-command-test-area-reason" })}
        disabled={command === null || dirty || pending || onOpenTestArea === undefined}
        onClick={() => { if (command !== null) onOpenTestArea?.("text_commands", command.name); }}
      >{labels.testAreaAction}</Button>
    </div>
    {command === null ? null : <ActionMenu
      label={common.moreActions}
      items={[{ label: labels.delete, danger: true, disabled: !canManageContent || pending, onSelect: requestDelete }]}
    />}
  </>;
  const pageActionHint = <span id="text-command-test-area-reason" aria-hidden={testAreaReason.length === 0}>{testAreaReason}</span>;
  const rawChatTarget = draft.chatTarget as string | null;
  const effectiveChatTarget = rawChatTarget === null || rawChatTarget === "channel_default"
    ? channelDefaultChatTarget
    : rawChatTarget as ChatOutputTarget;
  const chatTargetLabel = effectiveChatTarget === undefined ? "—" : labels.chatTargetLabels[effectiveChatTarget];
  const readOnlyProperties = <dl className="properties text-command-properties">
    <div>
      <dt>{labels.active}</dt>
      <dd className="text-command-properties__switch">
        <SwitchPrimitive
          aria-label={labels.active}
          checked={draft.enabled}
          disabled={!canOperate || pending}
          onCheckedChange={(enabled) => { setDraftField("enabled", enabled); }}
        />
        <span>{draft.enabled ? common.activeModule : common.pausedModule}</span>
      </dd>
    </div>
    <div><dt>{labels.name}</dt><dd className="mono">!{draft.name}</dd></div>
    <div><dt>{labels.aliases}</dt><dd>{draft.aliases.length === 0 ? "—" : draft.aliases.map((alias) => `!${alias}`).join(", ")}</dd></div>
    <div><dt>{labels.kind}</dt><dd>{labels.kindLabels[draft.kind]}</dd></div>
    {draft.kind === "list" ? null : <div><dt>{labels.response}</dt><dd className="text-command-properties__response">{draft.text || "—"}</dd></div>}
    <div><dt>{labels.minimumRole}</dt><dd>{labels.tierLabels[draft.minimumTier]}</dd></div>
    <div><dt>{labels.cooldownField}</dt><dd>{String(draft.cooldownSeconds)} s</dd></div>
    <div><dt>{labels.streamCondition}</dt><dd>{labels.streamLabels[draft.streamCondition]}</dd></div>
    <div><dt>{labels.gameFilter}</dt><dd>{draft.games.length === 0 ? labels.gameMultiSelect.allGames : draft.games.map(({ name }) => name).join(", ")}</dd></div>
    <div><dt>{labels.userCooldown}</dt><dd>{String(draft.userCooldownSeconds)} s</dd></div>
    <div><dt>{labels.responseType}</dt><dd>{labels.responseTypeLabels[draft.responseType]}</dd></div>
    <div><dt>{labels.chatTarget}</dt><dd>{chatTargetLabel}</dd></div>
    {draft.kind === "list" ? null : <div><dt>{labels.templateFieldLabels.usageText}</dt><dd className="text-command-properties__response">{draft.usageText || "—"}</dd></div>}
    <div><dt>{labels.variableAction}</dt><dd>{draft.variableAction === null
      ? "—"
      : `${draft.variableAction.name} · ${labels.variableOperations[draft.variableAction.operation]}${draft.variableAction.amount === null ? "" : ` ${String(draft.variableAction.amount)}`}`}</dd></div>
    {draft.timeoutAction === null ? null : <>
      <div><dt>{labels.timeoutDuration}</dt><dd>{draft.timeoutAction.minSeconds === draft.timeoutAction.maxSeconds
        ? `${String(draft.timeoutAction.minSeconds)} s`
        : `${String(draft.timeoutAction.minSeconds)}–${String(draft.timeoutAction.maxSeconds)} s`}</dd></div>
      <div><dt>{labels.timeoutFallbackTextOptional}</dt><dd className="text-command-properties__response">{draft.timeoutAction.fallbackText || "—"}</dd></div>
      <div><dt>{labels.timeoutReason}</dt><dd className="text-command-properties__response">{draft.timeoutAction.reason || "—"}</dd></div>
    </>}
  </dl>;
  const saveBar = <SaveStatus
    persistent
    dirty={dirty}
    pending={pending}
    saved={saved || (!isCreate && !dirty)}
    {...(saveError === undefined ? {} : { error: saveError })}
    invalid={attemptedSave && !valid}
    invalidMessage={labels.invalid}
    warnings={warnings}
    warningStatusLabel={(items, justSaved) => justSaved ? `✓ ${labels.saved} ${items.join(" ")}` : items.join(" ")}
    {...(concurrentConflict ? { conflict: {
      message: reloadError ? `${labels.conflictMessage} ${labels.reloadError}` : labels.conflictMessage,
      reloadLabel: reloadError ? common.retry : labels.reload,
      onReload: () => { void reloadServer(); },
    } } : {})}
    onInvalidSave={() => { setAttemptedSave(true); setValidationAttempt((attempt) => attempt + 1); }}
    onSave={() => { void saveDraft(); }}
    onDiscard={discardDraft}
    saveLabel={isCreate ? labels.create : labels.save}
    discardLabel={labels.discard}
    savedLabel={labels.saved}
    pendingLabel={labels.pending}
  />;
  const saveStatus = <div className="text-command-editor__save">{saveBar}</div>;
  return <div ref={editorRef} className="text-command-editor" role="region" aria-label={isCreate ? labels.add : labels.details(command.name)} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    // Legacy IME events can report keyCode 229 without setting isComposing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !isComposing && canManageContent && dirty && !pending) {
      event.preventDefault();
      void saveDraft();
    }
  }}>
    <PageHeader
      className="page-header--editor"
      kind="module"
      icon={null}
      title={labels.title}
      titleContent={isCreate ? labels.add : <span className="mono">!{command.name}</span>}
      headingLevel="h2"
      {...(pageMeta === undefined ? {} : { meta: pageMeta })}
      badge={<StatusLed state="ok" label={labels.ready} />}
      {...(canManageContent ? {
        active: draft.enabled,
        switchTitle: labels.active,
        switchDisabled: pending,
        switchBusy: pending,
        onToggle: (enabled: boolean) => { setDraftField("enabled", enabled); },
      } : {})}
      saveStatus={saveStatus}
      actions={pageActions}
      actionHint={pageActionHint}
    />
    <div className={`text-command-editor__scroll${canManageContent ? "" : " text-command-editor__scroll--readonly"}`}>
      {canManageContent ? <>
        <Section title={labels.triggerSection} className="text-command-trigger-section" headingAction={<div className="text-command-section-rule">
          <span className="ui-section__rule" aria-hidden="true" />
          {registeredVariableStatus}
        </div>}>{triggerFields}</Section>
        <Section title={labels.kind} headingAction={<div className="text-command-kind-choice"><SegmentChoice
          label={labels.kind}
          hint={labels.kindHints[draft.kind]}
          value={draft.kind}
          {...(serverFieldErrors.kind === undefined ? {} : { error: serverFieldErrors.kind })}
          reserveError
          options={kindOptions.map(({ value, label }) => ({ value, label }))}
          disabled={pending}
          onChange={(value) => { changeKind(value); }}
        /></div>}>
          {sections[0]?.content}
        </Section>
        {sections[1]?.content}
      </> : <>
        <RuleNote>{labels.managementLocked}</RuleNote>
        {readOnlyProperties}
      </>}
    </div>
    {guard.confirmOpen ? <ConfirmDialog
      opened
      title={labels.draftGuardTitle}
      description={labels.draftGuardDescription}
      cancelLabel={labels.continueEditing}
      confirmLabel={labels.discardAndSwitch}
      onCancel={() => { deleteAfterSaveRef.current = false; guard.continueEditing(); }}
      onConfirm={() => { guard.discardAndSwitch(); }}
      {...(valid ? { alternative: { label: labels.saveAndSwitch, onClick: () => { void guard.saveAndSwitch(); } } } : {})}
      pending={guard.saving}
      danger
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
    /> : null}
    <ConfirmDialog
      opened={confirmingDelete}
      title={labels.deleteTitle(command?.name ?? normalizedName)}
      description={labels.deleteConfirmation(command?.name ?? normalizedName, draft.aliases)}
      confirmLabel={labels.deleteConfirm(command?.name ?? normalizedName)}
      cancelLabel={labels.deleteCancel}
      onCancel={() => { setConfirmingDelete(false); }}
      onConfirm={() => { void remove(); }}
      danger
      pending={deleting}
      {...(deleteError === undefined ? {} : { error: deleteError })}
    />
  </div>;
};

const TextCommandsPanel = (props: {
  channelId: string;
  language?: DashboardLanguage | undefined;
  canManage?: boolean;
  canOperate?: boolean;
  botIsModerator?: boolean | null;
  onCloseInspector?: () => void;
  initialSelection?: string;
  onOpenTestArea?: (moduleId: "text_commands" | "faq", entryId: string) => void;
}): ReactElement => <TextCommandsPanelContent key={props.channelId} {...props} />;

const TextCommandsPanelContent = ({
  channelId,
  language,
  canManage: canManageContent = true,
    canOperate = false,
  botIsModerator = null,
  onCloseInspector,
  initialSelection,
  onOpenTestArea,
}: {
  channelId: string;
  language?: DashboardLanguage | undefined;
  canManage?: boolean;
  canOperate?: boolean;
  botIsModerator?: boolean | null;
  onCloseInspector?: () => void;
  initialSelection?: string;
  onOpenTestArea?: (moduleId: "text_commands" | "faq", entryId: string) => void;
}): ReactElement => {
  const labels = textCommandsTexts(language);
  const resolvedLanguage = language ?? dashboardLanguage();
  const common = dashboardCommonTexts(resolvedLanguage);
  const channelSettings = useChannelSettings(channelId);
  const queryClient = useDashboardQueryClient();
  const commandsQuery = useModuleQuery(channelId, "text_commands", "commands", (signal) => loadTextCommandData(channelId, signal));
  const refetchCommands = commandsQuery.refetch;
  const commands = useMemo(() => commandsQuery.data?.commands ?? [], [commandsQuery.data]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [preservedRename, setPreservedRename] = useState<{ from: string; to: string } | null>(null);
  const channelVariables = commandsQuery.data?.variables ?? [];
  const registeredVariablesQuery = useModuleQuery(channelId, "text_commands", "template-variables", (signal) => loadRegisteredTemplateVariables(channelId, signal));
  const registeredVariables = useMemo(() => registeredVariablesQuery.data ?? [], [registeredVariablesQuery.data]);
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useInspectorSelection<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const guardRef = useRef<((proceed: () => void, cancel?: () => void) => void) | null>(null);
  const guardSwitch = useCallback((proceed: () => void, cancel?: () => void): void => {
    const guard = guardRef.current;
    if (guard === null) proceed();
    else guard(proceed, cancel);
  }, []);
  const registerGuard = useCallback((next: ((proceed: () => void, cancel?: () => void) => void) | null): void => { guardRef.current = next; }, []);
  useEffect(() => registerDashboardNavigationGuard(guardSwitch), [guardSwitch]);
  const initialSelectionApplied = useRef(false);

  const refresh = useCallback(async (force = false): Promise<TextCommand[]> => {
    const cached = queryClient.getQueryData<TextCommandPanelData>(moduleQueryKey(channelId, "text_commands", "commands"));
    const data = force || cached === undefined
      ? await refetchModuleQueryData<TextCommandPanelData>(queryClient, channelId, "text_commands", "commands")
      : cached;
    return data.commands;
  }, [channelId, queryClient]);

  // Editor generation: bumped on every select, create-open, close and discard. A continuation
  // of an obsolete editor (captured token differs) must never change a newer selection or draft.
  const generationRef = useRef(0);
  const generation = useCallback((): number => generationRef.current, []);
  const onSaved = useCallback((token: number, name: string, preserveEditor = false): void => {
    if (token !== generationRef.current) return;
    generationRef.current += 1;
    setCreateOpen(false);
    if (preserveEditor && selectedName !== null && selectedName !== name) setPreservedRename({ from: selectedName, to: name });
    selectName(name);
    if (!preserveEditor && (selectedName !== name || createOpen)) setSelectionVersion((current) => current + 1);
  }, [createOpen, selectName, selectedName]);

  const write = useCallback(<Value,>(
    baselineRevision: number | null,
    mutation: (revision: number | null) => Promise<Value>,
    updateCache: (current: unknown, result: Value) => unknown,
  ): Promise<Value> => runModuleQueryWrite(
    queryClient,
    channelId,
    "text_commands",
    "commands",
    mutation,
    { baselineRevision, updateCache },
  ), [channelId, queryClient]);

  useEffect(() => {
    if (commandsQuery.isError) notify({ tone: "error", message: labels.loadError });
  }, [commandsQuery.isError, labels.loadError]);

  useEffect(() => {
    if (commandsQuery.isPending || commandsQuery.data === undefined || initialSelectionApplied.current || createOpen) return;
    const target = commands.find((command) => command.name === initialSelection) ?? (window.matchMedia("(max-width: 767px)").matches ? undefined : commands[0]);
    initialSelectionApplied.current = true;
    if (target === undefined || selectedName === target.name) return;
    guardSwitch(() => {
      generationRef.current += 1;
      setSelectionVersion((current) => current + 1);
      setMobileDetailOpen(initialSelection !== undefined);
      selectName(target.name);
    });
  }, [commands, commandsQuery.data, commandsQuery.isPending, createOpen, guardSwitch, initialSelection, selectName, selectedName]);

  const selected = useMemo(() => commands.find((command) => command.name === selectedName)
    ?? (preservedRename?.to === selectedName ? commands.find((command) => command.name === preservedRename.from) ?? null : null), [commands, preservedRename, selectedName]);
  const closeInspector = useCallback((): void => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      guardSwitch(() => { setMobileDetailOpen(false); });
      return;
    }
    guardSwitch(() => {
      generationRef.current += 1;
      setCreateOpen(false);
      closeSelection();
      setMobileDetailOpen(false);
      setSelectionVersion((current) => current + 1);
      onCloseInspector?.();
    });
  }, [closeSelection, guardSwitch, onCloseInspector]);
  const closeCreate = useCallback((): void => {
    guardSwitch(() => {
      generationRef.current += 1;
      setCreateOpen(false);
      setMobileDetailOpen(false);
      setSelectionVersion((current) => current + 1);
    });
  }, [guardSwitch]);
  const openCreate = (): void => guardSwitch(() => {
    generationRef.current += 1;
    closeSelection();
    setCreateOpen(true);
    setMobileDetailOpen(true);
    setSelectionVersion((current) => current + 1);
  });
  const selectCommand = (name: string): void => {
    if (selectedName === name && !createOpen) {
      setMobileDetailOpen(true);
      return;
    }
    guardSwitch(() => {
      generationRef.current += 1;
      setCreateOpen(false);
      selectName(name);
      setMobileDetailOpen(true);
      setSelectionVersion((current) => current + 1);
    });
  };
  const handleDeleted = (token: number): void => {
    if (token !== generationRef.current) return;
    generationRef.current += 1;
    setCreateOpen(false);
    closeSelection();
    setMobileDetailOpen(false);
    setSelectionVersion((current) => current + 1);
    initialSelectionApplied.current = false;
  };

  const query = search.trim().toLocaleLowerCase();
  const visibleCommands = useMemo(() => commands.filter((command) => {
    const matchesSearch = query.length === 0 || [command.name, ...command.aliases, command.text, command.usageText ?? "", labels.kindLabels[command.kind]]
      .some((value) => value.toLocaleLowerCase().includes(query));
    const matchesStatus = statusFilter === "all" || command.enabled === (statusFilter === "active");
    const matchesModule = moduleFilter === null || modulesUsedByCommand(command, registeredVariables).includes(moduleFilter);
    return matchesSearch && matchesStatus && matchesModule;
  }), [commands, labels.kindLabels, moduleFilter, query, registeredVariables, statusFilter]);
  const moduleIds = useMemo(() => [...new Set(registeredVariables.map(({ moduleId }) => moduleId).filter((moduleId) => !isSystemTemplateModuleId(moduleId)))].sort((left, right) => left.localeCompare(right)), [registeredVariables]);
  const moduleLabels = useMemo(() => new Map(registeredVariables.map(({ moduleId, pickerGroup }) => [moduleId, pickerGroup?.label[resolvedLanguage] ?? moduleId])), [registeredVariables, resolvedLanguage]);
  const listStatus = commandsQuery.data === undefined
    ? commandsQuery.isPending ? "loading" : "error"
    : visibleCommands.length === 0 ? "empty" : "success";
  const createReason = canManageContent ? undefined : labels.managementLocked;
  const toolbar = <div className="text-command-list-toolbar">
    <ListToolbar
      language={resolvedLanguage}
      searchLabel={labels.search}
      searchPlaceholder={labels.search}
      searchClearLabel={common.clearSearch}
      searchValue={search}
      onSearchChange={setSearch}
      create={{ label: labels.add, onClick: openCreate, disabled: !canManageContent, ...(createReason === undefined ? {} : { reason: createReason }) }}
      className="text-command-list-toolbar__search"
    />
    <div className="text-command-filter-row">
      <ChipGroup
        ariaLabel={labels.statusFilter}
        value={statusFilter}
        onChange={(value) => { setStatusFilter((value ?? "all") as "all" | "active" | "inactive"); }}
        options={[
          { value: "all", label: labels.filterAll },
          { value: "active", label: labels.filterActive },
          { value: "inactive", label: labels.filterInactive },
        ]}
      />
      <span className="text-command-filter-count">{labels.entryCount(visibleCommands.length)}</span>
    </div>
    <div className="text-command-module-filter">
      <Select
        label={labels.usedModuleVariables}
        value={moduleFilter ?? "all"}
        options={[{ value: "all", label: labels.allModules }, ...moduleIds.map((id) => ({ value: id, label: moduleLabels.get(id) ?? id }))]}
        disabled={moduleIds.length === 0}
        onChange={(value) => { setModuleFilter(value === "all" ? null : value); }}
      />
    </div>
  </div>;
  const list = <LoadState variant="panel-600" status={listStatus}
      loading={<LoadStateLines rows={8} height={34} />}
      empty={<p className="empty-state">{commands.length > 0 ? common.noMatches : labels.empty}</p>}
      error={<p className="muted">{labels.loadError}</p>}
      queryError={{ message: labels.loadError, onRetry: () => { void refetchCommands(); } }}
      refreshError={commandsQuery.isRefetchError}>
      <div className="text-command-list">{visibleCommands.map((command) => {
        const response = command.variableAction !== null
          ? labels.actionResponse(command.variableAction.name, command.variableAction.operation, command.variableAction.amount)
          : command.text.trim().length > 0 ? command.text : command.kind === "list" ? labels.kindHints.list : labels.noResponse;
        const aliases = command.aliases.map((alias) => `!${alias}`).join(", ");
        const summary = aliases.length > 0 ? aliases : response.split(/\r?\n/u)[0] ?? labels.noResponse;
        const kindBadge = command.variableAction !== null
          ? labels.variableBadge
          : labels.kindLabels[command.kind];
        return <button
          key={command.name}
          ref={rowRef(command.name)}
          type="button"
          className="text-command-row"
          aria-current={selectedName === command.name ? "true" : undefined}
          onClick={() => { selectCommand(command.name); }}
        >
          <span className="text-command-row__status"><StatusLed state={command.enabled ? "ok" : "off"} label={command.enabled ? labels.filterActive : labels.filterInactive} dotOnly /></span>
          <span className="text-command-row__copy">
            <span className="text-command-row__top">
              <strong className="mono">!{command.name}</strong>
              <Badge tone="neutral">{kindBadge}</Badge>
            </span>
            <span className="text-command-row__response" title={summary}>{summary}</span>
          </span>
          <span className="text-command-row__uses">{command.useCount}×</span>
        </button>;
      })}</div>
    </LoadState>

  const detail = selected !== null ? <TextCommandEditor
    key={`selected-${String(selectionVersion)}`}
    channelId={channelId}
    {...(channelSettings.data === undefined ? {} : { channelDefaultChatTarget: channelSettings.data.defaultChatTarget })}
    language={language}
    registeredVariables={registeredVariables}
    registeredVariablesLoaded={registeredVariablesQuery.data !== undefined}
    registeredVariablesPending={registeredVariablesQuery.isPending}
    registeredVariablesRefreshError={registeredVariablesQuery.isRefetchError}
    onRetryRegisteredVariables={() => { void registeredVariablesQuery.refetch(); }}
    initial={draftFromCommand(selected)}
    command={selected}
    commands={commands}
    channelVariables={channelVariables}
    canManageContent={canManageContent}
    canOperate={canOperate}
    botIsModerator={botIsModerator}
    onClose={closeInspector}
    onGuardChange={registerGuard}
    onRefresh={refresh}
    onSaved={onSaved}
    generation={generation}
    onWrite={write}
    onDeleted={handleDeleted}
    {...(onOpenTestArea === undefined ? {} : { onOpenTestArea })}
  /> : createOpen ? <TextCommandEditor
    key={`create-${String(selectionVersion)}`}
    channelId={channelId}
    {...(channelSettings.data === undefined ? {} : { channelDefaultChatTarget: channelSettings.data.defaultChatTarget })}
    language={language}
    registeredVariables={registeredVariables}
    registeredVariablesLoaded={registeredVariablesQuery.data !== undefined}
    registeredVariablesPending={registeredVariablesQuery.isPending}
    registeredVariablesRefreshError={registeredVariablesQuery.isRefetchError}
    onRetryRegisteredVariables={() => { void registeredVariablesQuery.refetch(); }}
    initial={newCommandDraft()}
    command={null}
    commands={commands}
    channelVariables={channelVariables}
    canManageContent={canManageContent}
    canOperate={canOperate}
    botIsModerator={botIsModerator}
    onClose={closeCreate}
    onGuardChange={registerGuard}
    onRefresh={refresh}
    onSaved={onSaved}
    generation={generation}
    onWrite={write}
    onDeleted={handleDeleted}
  /> : <EmptyState
    title={labels.selectionPrompt}
    description={labels.selectionDescription}
  />;

  return <div className="command-panel">
    <CollectionPage
      headingLevel="h2"
      title={labels.title}
      toolbar={toolbar}
      list={list}
      detail={detail}
      detailOpen={mobileDetailOpen}
      backLabel={labels.back}
      onCloseDetail={closeInspector}
    />
  </div>;
};

export default TextCommandsPanel;
