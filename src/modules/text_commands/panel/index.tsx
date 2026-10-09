import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { dashboardCommonTexts, dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";
import {
  Badge, Button, ChatOutputTargetControl, ChatPreview, ChoiceCards, ConfirmDialog, EditorShell, EmptyCellValue, Field, FieldPair, ListDetail, ListToolbar, NumberField, Select,
  GamePicker, InspectorFieldRow, InspectorSection, LoadState, Skeleton, TimeoutDurationRangeFields,
  registerDashboardNavigationGuard, SegmentedControl, Switch, TagInput, TemplateText, TextArea, useDraft, useDraftGuard, useInspectorSelection, notify,
  type EditorInvalidField,
} from "../../../dashboard/ui";
import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_COMMAND_KINDS, TEXT_COMMAND_MAX_ALIASES, TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TEMPLATE_FIELDS, TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, type TextCommand, type TextCommandGame, type TextCommandKind, type TextCommandMinimumTier, type TextCommandResponseType, type TextCommandStreamCondition } from "../contracts";
import { MODERATION_TIMEOUT_MAX_SECONDS } from "../../contracts/moderation";
import { minimumTierAfterVariableOperation } from "./editor-state";
import { commandListReply, TEXT_COMMAND_DEFAULT_TEXTS, TEXT_COMMAND_DEFAULT_USAGE_TEXT, textCommandDefaultsFor } from "../contracts/chat-defaults";
import { statusForTier, validCommandName } from "../domain";
import { invalidTemplateParameters, renderTemplate, templateVariableNames, unknownTemplateVariables, worstCaseTemplateLength, type PanelTemplateWarning, type TemplateVariable } from "../contract";
import { effectivePanelTemplateVariables, panelTemplateOptions, registeredTemplatePickerGroup } from "../../../dashboard/ui";
import { createTextCommand, deleteTextCommand, loadTextCommandData, loadRegisteredTemplateVariables, saveTextCommand, searchTextGames, textBlockNamesForPicker, toggleTextCommand, type TextCommandChannelVariable } from "./service";
import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import type { TextCommandPanelData } from "./service";
import { textCommandsTexts } from "./locale";
import { convertLeadingSlashCommand, parseLeadingSlashCommand, SLASH_COMMAND_NAMES } from "./slash-command";

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

interface CommandDraft {
  name: string;
  text: string;
  usageText: string;
  kind: TextCommandKind;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number | "";
  aliases: string[];
  userCooldownSeconds: number | "";
  streamCondition: TextCommandStreamCondition;
  games: TextCommandGame[];
  responseType: TextCommandResponseType;
  chatTarget: TextCommand["chatTarget"];
  variableAction: TextCommand["variableAction"];
  timeoutAction: { minSeconds: number | ""; maxSeconds: number | ""; fallbackText: string; reason: string } | null;
}

const draftTimeoutAction = (timeoutAction: TextCommand["timeoutAction"] | undefined): CommandDraft["timeoutAction"] => {
  if (timeoutAction === null || timeoutAction === undefined) return null;
  return { ...timeoutAction, reason: timeoutAction.reason ?? "" };
};

const draftFromCommand = (command: TextCommand): CommandDraft => ({
  name: command.name,
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
});

const newCommandDraft = (): CommandDraft => ({
  name: "",
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
  chatTarget: "source_only",
  variableAction: null,
  timeoutAction: null,
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

const commandDraftIsValid = (draft: CommandDraft, channelVariables: readonly TextCommandChannelVariable[]): boolean => {
  const name = normalizeCommandName(draft.name);
  const timeout = draft.timeoutAction;
  const variable = draft.variableAction;
  const validVariable = validCommandVariableAction(variable, channelVariables);
  const validTimeout = draft.kind === "timeout"
    ? timeout !== null && typeof timeout.minSeconds === "number" && Number.isInteger(timeout.minSeconds) &&
      typeof timeout.maxSeconds === "number" && Number.isInteger(timeout.maxSeconds) && timeout.minSeconds >= 1 &&
      timeout.minSeconds <= timeout.maxSeconds && timeout.maxSeconds <= MODERATION_TIMEOUT_MAX_SECONDS &&
      timeout.fallbackText.length <= 500 && timeout.reason.length <= 500
    : timeout === null;
  const responseRequired = draft.kind !== "list" && draft.kind !== "timeout" && variable === null && draft.text.trim().length === 0;
  return validCommandName(name) && draft.aliases.every(validCommandName) && !draft.aliases.includes(name) && draft.aliases.length <= TEXT_COMMAND_MAX_ALIASES &&
    typeof draft.cooldownSeconds === "number" && Number.isInteger(draft.cooldownSeconds) && draft.cooldownSeconds >= 0 && draft.cooldownSeconds <= 86400 &&
    typeof draft.userCooldownSeconds === "number" && Number.isInteger(draft.userCooldownSeconds) && draft.userCooldownSeconds >= 0 && draft.userCooldownSeconds <= 86400 &&
    validVariable && validTimeout && !responseRequired && draft.text.length <= 500 && (draft.kind === "list" || draft.usageText.length <= 500);
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

const formatDate = (value: string, language: DashboardLanguage): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "medium" }).format(date);
};

const commandRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
};

interface TextCommandRowProperties {
  initial: TextCommand;
  language?: DashboardLanguage | undefined;
  selected: boolean;
  onSelect: () => void;
  rowRef: (row: HTMLTableRowElement | null) => void;
  toggleBusy: boolean;
  onToggle: () => Promise<void>;
}

const TextCommandRow = ({ initial, language, selected, onSelect, rowRef, toggleBusy, onToggle }: TextCommandRowProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  return (
    <tr ref={rowRef} tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td>{labels.kindLabels[initial.kind]}</td>
      <td className={`table__answer${initial.text.length === 0 && initial.variableAction !== null ? " table__answer--placeholder" : ""}`} title={initial.kind === "list" ? undefined : initial.text}>
        {initial.kind === "list" ? <EmptyCellValue language={language} /> : initial.text.length > 0 ? initial.text : initial.variableAction === null ? <EmptyCellValue language={language} /> : labels.actionResponse(initial.variableAction.name, initial.variableAction.operation, initial.variableAction.amount)}
      </td>
      <td><Badge tone={initial.minimumTier === "everyone" ? "neutral" : "brand"}>{labels.tierLabels[initial.minimumTier]}</Badge></td>
      <td><div onClick={(event) => { event.stopPropagation(); }} onKeyDown={(event) => { event.stopPropagation(); }}>
        <Switch
          ariaLabel={`${labels.active}: !${initial.name} · ${initial.enabled ? labels.enabled : labels.disabled}`}
          checked={initial.enabled}
          pending={toggleBusy}
          onChange={() => { void onToggle(); }}
        />
      </div></td>
    </tr>
  );
};

interface TextCommandEditorProperties {
  channelId: string;
  language?: DashboardLanguage | undefined;
  initial: CommandDraft;
  command: TextCommand | null;
  commands: readonly TextCommand[];
  channelVariables: readonly TextCommandChannelVariable[];
  canManageContent: boolean;
  botIsModerator: boolean | null;
  onClose: () => void;
  onGuardChange: (guard: ((proceed: () => void, cancel?: () => void) => void) | null) => void;
  onRefresh: (force?: boolean) => Promise<TextCommand[]>;
  /** Called in the same step as the committed cache write; a no-op if the selection moved on since. */
  onSaved: (token: number, name: string) => void;
  /** Current editor generation; capture it before a mutation starts. */
  generation: () => number;
  onWrite: <Value>(
    baselineRevision: number | null,
    write: (baselineRevision: number | null) => Promise<Value>,
    updateCache: (current: unknown, result: Value) => unknown,
  ) => Promise<Value>;
  onDeleted: (token: number) => void;
}

const TextCommandEditor = ({ channelId, language, initial, command, commands, channelVariables, canManageContent, botIsModerator, onClose, onGuardChange, onRefresh, onSaved, generation, onWrite, onDeleted }: TextCommandEditorProperties): ReactElement => {
  const labels = useMemo(() => textCommandsTexts(language), [language]);
  const searchGames = useCallback((query: string) => searchTextGames(channelId, query), [channelId]);
  const resolvedLanguage = language ?? dashboardLanguage();
  const { value: draft, setValue, dirty, reset, accept } = useDraft<CommandDraft>(initial);
  const draftRevision = useRef(command?.revision ?? null);
  const [active, setActive] = useState(command?.enabled ?? true);
  const [activePending, setActivePending] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<{ field: "name" | "aliases"; message: string; invalidAlias?: string } | null>(null);
  const [concurrentConflict, setConcurrentConflict] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [serverWarnings, setServerWarnings] = useState<readonly PanelTemplateWarning[]>([]);
  const [minimumTierExplicit, setMinimumTierExplicit] = useState(false);
  const registeredVariablesQuery = useModuleQuery(channelId, "text_commands", "template-variables", (signal) => loadRegisteredTemplateVariables(channelId, signal));
  const registeredVariables = registeredVariablesQuery.data ?? [];
  const libraryBlocks = textBlockNamesForPicker(registeredVariables);
  const [selectedLibraryBlock, setSelectedLibraryBlock] = useState("");
  const isCreate = command === null;
  const blockVariables: TemplateVariable[] = libraryBlocks.map((name) => ({ name, group: "channel", sample: name, maxLength: 500 }));
  const baseTemplateFields = templateFieldsForKind(draft.kind, channelVariables, draft.timeoutAction !== null);
  const variableAction = draft.variableAction;
  const templateVariables = (field: CommandTemplateField) => [
    ...panelTemplateOptions("chat_command", [], channelVariables, resolvedLanguage),
    ...libraryBlocks.map((name) => ({ name, label: name, description: labels.libraryText, sample: "", group: "channel" as const, kind: "module" as const, isTextBlock: true })),
    ...registeredVariables.filter((variable) => !variable.isTextBlock && variable.name.includes(".") &&
      (draft.timeoutAction !== null && (field === "text" || field === "timeoutFallbackText") || !variable.name.startsWith("timeout.")) &&
      (variable.contexts?.includes("chat_command") ?? true)).map((variable) => {
      const pickerCopy = variable.picker?.[resolvedLanguage];
      const pickerGroup = registeredTemplatePickerGroup(variable, resolvedLanguage);
      return {
        name: variable.name,
        label: pickerCopy?.label ?? variable.name,
        description: pickerCopy?.description ?? variable.name,
        sample: variable.sample,
        ...(pickerCopy?.sample === undefined ? {} : { pickerSample: pickerCopy.sample }),
        group: variable.group ?? "channel" as const,
        kind: "module" as const,
        ...(pickerGroup === undefined ? {} : { pickerGroup }),
        ...(variable.external === undefined ? {} : { external: variable.external }),
        ...(variable.parameters === undefined ? {} : { parameters: variable.parameters }),
        ...(variable.parameters === "currency_pair" ? { parameter: { value: variable.parameterDefault ?? "USD EUR" } } : {}),
      };
    }),
  ];
  const templateFields = Object.fromEntries(Object.entries(baseTemplateFields)
    .map(([field, variables]) => [field, [...variables, ...blockVariables]]));
  const templateValue = (field: CommandTemplateField): string => field === "timeoutFallbackText"
    ? draft.timeoutAction?.fallbackText ?? ""
    : draft[field];
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
    .map(([field, variables]) => [field, [...variables, ...blockVariables]]));
  const validationTemplateValue = (field: string): string => field === "timeoutFallbackText"
    ? validationDraft.timeoutAction?.fallbackText ?? ""
    : validationDraft[field as "text" | "usageText"];
  const validationResponseInvalid = Object.keys(validationTemplateFields).some((field) => {
    const value = validationTemplateValue(field);
    const optionalTimeoutText = validationDraft.kind === "timeout" && (field === "text" || field === "timeoutFallbackText");
    return (value.trim().length === 0 && !optionalTimeoutText && !(field === "text" && validationDraft.variableAction !== null && validationDraft.timeoutAction === null) && field !== "usageText") || value.length > 500;
  });
  const normalizedName = normalizeCommandName(draft.name);
  const sameNameAlias = draft.aliases.includes(normalizedName);
  const invalidAlias = draft.aliases.find((alias) => !validCommandName(alias));
  const nameError = fieldError?.field === "name" ? fieldError.message : attemptedSave && normalizedName.length === 0 ? labels.nameMissing : attemptedSave && !validCommandName(normalizedName) ? labels.nameInvalid : undefined;
  const aliasesError = fieldError?.field === "aliases" ? fieldError.message : sameNameAlias ? labels.aliasIsName : invalidAlias !== undefined ? labels.aliasInvalid(invalidAlias) : attemptedSave && draft.aliases.length > TEXT_COMMAND_MAX_ALIASES ? labels.tagInputMessages.atLimitHint : undefined;
  const cooldownInvalid = draft.cooldownSeconds === "" || !Number.isInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 0 || draft.cooldownSeconds > 86400;
  const userCooldownInvalid = draft.userCooldownSeconds === "" || !Number.isInteger(draft.userCooldownSeconds) || draft.userCooldownSeconds < 0 || draft.userCooldownSeconds > 86400;
  const templateFieldNames = Object.keys(templateFields) as CommandTemplateField[];
  const responseFieldError = slashInput.status === "invalid"
    ? labels.slashSyntaxError(slashInput.command)
    : validationDraft.text.length > 500
    ? labels.fieldTooLong
    : attemptedSave && validationDraft.kind !== "timeout" && validationDraft.kind !== "list" && validationDraft.variableAction === null && validationDraft.text.trim().length === 0
      ? labels.responseMissing
      : undefined;
  const timeoutRangeInvalid = validationDraft.kind === "timeout" && (validationDraft.timeoutAction === null ||
    typeof validationDraft.timeoutAction.minSeconds !== "number" || !Number.isInteger(validationDraft.timeoutAction.minSeconds) || validationDraft.timeoutAction.minSeconds < 1 ||
    typeof validationDraft.timeoutAction.maxSeconds !== "number" || !Number.isInteger(validationDraft.timeoutAction.maxSeconds) ||
    validationDraft.timeoutAction.minSeconds > validationDraft.timeoutAction.maxSeconds || validationDraft.timeoutAction.maxSeconds > MODERATION_TIMEOUT_MAX_SECONDS);
  const timeoutReasonError = validationDraft.timeoutAction !== null && validationDraft.timeoutAction.reason.length > 500 ? labels.fieldTooLong : undefined;
  const timeoutFallbackError = validationDraft.timeoutAction !== null && validationDraft.timeoutAction.fallbackText.length > 500 ? labels.fieldTooLong : undefined;
  const variableActionInvalid = !validCommandVariableAction(validationDraft.variableAction, channelVariables);
  const variableActionNameInvalid = validationDraft.variableAction !== null && !channelVariables.some((entry) => entry.name === validationDraft.variableAction?.name);
  const variableActionAmountInvalid = validationDraft.variableAction !== null && (
    validationDraft.variableAction.operation === "set_argument"
      ? validationDraft.variableAction.amount !== 0
      : validationDraft.variableAction.amount === null || !Number.isInteger(validationDraft.variableAction.amount) ||
        (validationDraft.variableAction.operation === "add" || validationDraft.variableAction.operation === "subtract"
          ? validationDraft.variableAction.amount < 1 || validationDraft.variableAction.amount > 1000
          : validationDraft.variableAction.amount < -999999999 || validationDraft.variableAction.amount > 999999999)
  );
  const variableActionError = attemptedSave && variableActionInvalid ? labels.variableActionInvalid : undefined;
  const aliasesInvalid = draft.aliases.length > TEXT_COMMAND_MAX_ALIASES || sameNameAlias || invalidAlias !== undefined;
  const valid = slashInput.status !== "invalid" && !validationResponseInvalid &&
    (validationDraft.variableAction === null || validationDraft.kind === "text" || validationDraft.kind === "timeout") &&
    commandDraftIsValid(validationDraft, channelVariables);
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
    description: tierDescription(tier, labels),
    icon: `tier${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}` as "tierEveryone" | "tierSubscriber" | "tierVip" | "tierModerator" | "tierBroadcaster",
  }));
  const kindOptions = TEXT_COMMAND_KINDS.map((kind) => ({ value: kind, label: labels.kindLabels[kind], description: labels.kindHints[kind] }));
  const announcementWarning = draft.responseType === "announcement" && botIsModerator === false ? labels.announcementWarning : undefined;
  const slashSuggestions = slashInput.status === "suggestions"
    ? SLASH_COMMAND_NAMES.filter((name) => name.startsWith(slashInput.fragment))
    : slashInput.status === "invalid" ? [slashInput.command] : [];
  const slashEffect = slashInput.status !== "valid" ? null
    : slashInput.command === "timeout"
      ? labels.slashTimeoutEffect(slashInput.minSeconds ?? 0, slashInput.maxSeconds ?? 0)
      : slashInput.command === "announce" ? labels.slashAnnouncementEffect : labels.slashShoutoutEffect;
  const advancedIssue = attemptedSave && (cooldownInvalid || userCooldownInvalid)
    ? "error" as const
    : undefined;
  const settingsIssue = nameError !== undefined || aliasesError !== undefined || responseFieldError !== undefined ||
    timeoutReasonError !== undefined || timeoutFallbackError !== undefined || (validationDraft.kind !== "list" && validationDraft.usageText.length > 500) ||
    (attemptedSave && (timeoutRangeInvalid || variableActionInvalid))
    ? "error" as const
    : announcementWarning !== undefined || localWarnings.length > 0 || serverWarnings.length > 0
      ? "warning" as const
      : undefined;
  const listPreview = commandListReply(commands.filter((item) => item.enabled && item.name !== command?.name).map((item) => item.name));
  const invalidFields: EditorInvalidField[] = [];
  if ((attemptedSave || fieldError?.field === "name") && nameError !== undefined) {
    invalidFields.push({ id: "command-name", label: labels.name, message: nameError, sectionId: "settings" });
  }
  if ((attemptedSave || fieldError?.field === "aliases" || aliasesInvalid) && aliasesError !== undefined) {
    const invalidAliasToFocus = fieldError?.field === "aliases"
      ? fieldError.invalidAlias ?? (sameNameAlias ? normalizedName : invalidAlias ?? draft.aliases[0])
      : sameNameAlias ? normalizedName : invalidAlias ?? draft.aliases[0];
    invalidFields.push({
      id: "command-aliases",
      ...(invalidAliasToFocus === undefined ? {} : { focusId: `command-aliases-remove-${encodeURIComponent(invalidAliasToFocus)}` }),
      label: labels.aliases,
      message: aliasesError,
      sectionId: "settings",
    });
  } else if (attemptedSave && draft.aliases.length > TEXT_COMMAND_MAX_ALIASES) {
    invalidFields.push({
      id: "command-aliases",
      ...(draft.aliases[0] === undefined ? {} : { focusId: `command-aliases-remove-${encodeURIComponent(draft.aliases[0])}` }),
      label: labels.aliases,
      message: labels.tagInputMessages.atLimitHint,
      sectionId: "settings",
    });
  }
  if (attemptedSave && timeoutRangeInvalid) {
    invalidFields.push({ id: "command-timeout-minimum", label: labels.timeoutDuration, message: labels.timeoutRangeInvalid, sectionId: "settings" });
  }
  if (attemptedSave && timeoutReasonError !== undefined) {
    invalidFields.push({ id: "command-timeout-reason", label: labels.timeoutReason, message: timeoutReasonError, sectionId: "settings" });
  }
  if (attemptedSave && responseFieldError !== undefined) {
    invalidFields.push({ id: "command-text", label: draft.kind === "timeout" ? labels.responseOptional : labels.response, message: responseFieldError, sectionId: "settings" });
  }
  if (attemptedSave && timeoutFallbackError !== undefined) {
    invalidFields.push({ id: "command-timeoutFallbackText", label: labels.timeoutFallbackTextOptional, message: timeoutFallbackError, sectionId: "settings" });
  }
  if (attemptedSave && validationDraft.kind !== "list" && validationDraft.usageText.length > 500) {
    invalidFields.push({ id: "command-usageText", label: labels.templateFieldLabels.usageText, message: labels.fieldTooLong, sectionId: "settings" });
  }
  if (attemptedSave && variableActionNameInvalid) {
    invalidFields.push({
      id: channelVariables.length === 0 ? "command-variable-action" : "command-variable-name",
      label: labels.variableAction,
      message: labels.variableActionInvalid,
      sectionId: "settings",
    });
  }
  if (attemptedSave && variableActionAmountInvalid) {
    invalidFields.push({ id: "command-variable-amount", label: labels.variableAmount, message: labels.variableActionInvalid, sectionId: "settings" });
  }
  if (attemptedSave && cooldownInvalid) {
    invalidFields.push({ id: "command-cooldown", label: labels.cooldown, message: labels.numberMissing, sectionId: "advanced" });
  }
  if (attemptedSave && userCooldownInvalid) {
    invalidFields.push({ id: "command-user-cooldown", label: labels.userCooldown, message: labels.numberMissing, sectionId: "advanced" });
  }
  const setDraftField = <Key extends keyof CommandDraft>(key: Key, value: CommandDraft[Key]): void => {
    if (key === "minimumTier") setMinimumTierExplicit(true);
    setValue((current) => ({ ...current, [key]: value }));
    setSaved(false); setConcurrentConflict(false); setReloadError(false);
    if (key === "name" || key === "aliases") setFieldError(null);
  };
  const variableActionEditor = draft.kind === "text" || draft.kind === "timeout" ? <Switch
    id="command-variable-action"
    layout="card"
    label={labels.variableAction}
    description={variableAction === null ? labels.variableSelectHint : labels.variableOperationHelp[variableAction.operation]}
    checked={variableAction !== null}
    disabled={!canManageContent || pending}
    onChange={(enabled) => {
      setDraftField("variableAction", enabled
        ? { name: channelVariables[0]?.name ?? "", operation: "add", amount: 1 }
        : null);
    }}
  >
    {variableAction === null ? <div className="command-variable-action" data-testid="command-variable-action-slot" style={{ height: "calc(var(--s10) * 8)", overflowY: "auto" }} aria-hidden="true" /> : <div className="command-variable-action" data-testid="command-variable-action-slot" style={{ height: "calc(var(--s10) * 8)", overflowY: "auto" }}>
      <Select
        id="command-variable-name"
        label={labels.variableSelect}
        hint={labels.variableSelectHint}
        {...(attemptedSave && variableActionNameInvalid ? { error: labels.variableActionInvalid } : {})}
        value={variableAction.name || null}
        placeholder={labels.variableNone}
        options={channelVariables.map((variable) => ({ value: variable.name, label: variable.name, description: `${String(variable.value)}${variable.description.length > 0 ? ` · ${variable.description}` : ""}` }))}
        disabled={!canManageContent || pending || channelVariables.length === 0}
        onChange={(name) => { if (name !== null) setDraftField("variableAction", { ...variableAction, name }); }}
      />
      <FieldPair>
        <SegmentedControl
          label={labels.variableAction}
          hint={labels.variableOperationHelp[variableAction.operation]}
          value={variableAction.operation}
          options={( ["add", "subtract", "set", "set_argument"] as const).map((operation) => ({ value: operation, label: labels.variableOperations[operation] }))}
          disabled={!canManageContent || pending}
          onChange={(operation) => {
            const nextOperation = operation as typeof variableAction.operation;
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
          <NumberField
            id="command-variable-amount"
            label={labels.variableAmount}
            hint={labels.variableOperationHelp[variableAction.operation]}
            min={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1 : -999999999}
            max={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1000 : 999999999}
            step={1}
            increaseLabel={labels.variableAmount}
            decreaseLabel={labels.variableAmount}
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
  </Switch> : null;
  const responseTypeEditor = draft.kind === "shoutout" ? null : <SegmentedControl
    label={labels.responseType}
    hint={labels.responseTypeHints[draft.responseType]}
    value={draft.responseType}
    options={( ["say", "reply", "announcement"] as const).map((value) => ({ value, label: labels.responseTypeLabels[value] }))}
    {...(announcementWarning === undefined ? {} : { warning: announcementWarning })}
    disabled={!canManageContent || pending}
    onChange={(value) => { setDraftField("responseType", value as TextCommandResponseType); }}
  />;
  const chatTargetEditor = <ChatOutputTargetControl
    label={labels.chatTarget}
    value={draft.chatTarget}
    includeWhereAsked
    disabled={!canManageContent || pending}
    onChange={(chatTarget) => { setDraftField("chatTarget", chatTarget); }}
  />;

  const completeSwitchRef = useRef<() => boolean>(() => false);
  const saveDraft = useCallback(async (): Promise<string | null> => {
    setAttemptedSave(true);
    if (!canManageContent) return labels.invalid;
    const parsedSlashInput = parseLeadingSlashCommand(draft.text);
    if (parsedSlashInput.status === "invalid") return labels.invalid;
    const savedDraft = parsedSlashInput.status === "valid"
      ? convertLeadingSlashCommand(draft, parsedSlashInput, {
        text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout,
        usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT,
      })
      : draft;
    if (savedDraft !== draft) setValue(savedDraft);
    if (!commandDraftIsValid(savedDraft, channelVariables)) return labels.invalid;
    const payload = {
      name: normalizeCommandName(savedDraft.name),
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
      variableAction: savedDraft.variableAction,
      timeoutAction: savedDraft.timeoutAction === null ? null : {
        minSeconds: typeof savedDraft.timeoutAction.minSeconds === "number" ? savedDraft.timeoutAction.minSeconds : 0,
        maxSeconds: typeof savedDraft.timeoutAction.maxSeconds === "number" ? savedDraft.timeoutAction.maxSeconds : 0,
        fallbackText: savedDraft.timeoutAction.fallbackText,
        reason: savedDraft.timeoutAction.reason,
      },
    };
    setPending(true); setDeleteError(undefined); setFieldError(null); setConcurrentConflict(false); setReloadError(false); setSaved(false);
    try {
      const baselineRevision = isCreate ? null : draftRevision.current;
      const token = generation();
      const result = await onWrite(
        baselineRevision,
        (revision) => command === null
          ? createTextCommand(channelId, payload)
          : saveTextCommand(channelId, { oldName: command.name, revision: requireCommandRevision(revision), ...payload }),
        (current, mutationResult) => {
          const next = updateCommandCache(current, mutationResult.command, command?.name);
          // A held "save and switch" navigates to its target here; otherwise select the saved command.
          if (token !== generation() || !completeSwitchRef.current()) onSaved(token, mutationResult.command.name);
          return next;
        },
      );
      draftRevision.current = result.command.revision;
      accept({ ...savedDraft, ...payload, name: payload.name });
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
      notify({ tone: "error", message: labels.saveError });
      return labels.saveError;
    } finally { setPending(false); }
  }, [accept, canManageContent, channelId, channelVariables, command, draft, generation, isCreate, labels, onRefresh, onSaved, onWrite, setAttemptedSave, setConcurrentConflict, setFieldError, setPending, setSaved, setServerWarnings, setValue]);

  const guard = useDraftGuard(dirty, saveDraft, reset);
  useEffect(() => { completeSwitchRef.current = guard.completeSwitch; }, [guard.completeSwitch]);
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

  const changeKind = (kind: TextCommandKind): void => {
    setValue((current) => {
      const defaults = kind === "shoutout" ? textCommandDefaultsFor(kind) : null;
      return {
        ...current,
        kind,
        text: kind === "list" ? "" : defaults?.text ?? (current.kind === "list" ? "" : current.text),
        variableAction: kind === "text" || kind === "timeout" ? current.variableAction : null,
        timeoutAction: kind === "timeout"
          ? current.timeoutAction ?? { minSeconds: 120, maxSeconds: 120, fallbackText: "", reason: "" }
          : null,
        usageText: kind === "list" ? "" : kind === "shoutout"
          ? current.usageText || defaults?.usageText || TEXT_COMMAND_DEFAULT_USAGE_TEXT
          : current.kind === "shoutout" ? "" : current.usageText,
        ...(isCreate && kind === "shoutout" ? { minimumTier: "moderator" as const } : {}),
      };
    });
    setSaved(false); setConcurrentConflict(false); setReloadError(false);
  };

  const handleSave = async (): Promise<void> => {
    await saveDraft();
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
      setActive(latest.enabled);
      setConcurrentConflict(false); setFieldError(null); setDeleteError(undefined); setServerWarnings([]);
    } catch {
      setReloadError(true);
    }
  };

  const toggleActive = async (next: boolean): Promise<void> => {
    if (command === null) return;
    setActivePending(true);
    try {
      const baselineRevision = draftRevision.current;
      const result = await onWrite(
        baselineRevision,
        (revision) => toggleTextCommand(channelId, command.name, requireCommandRevision(revision), next),
        (current, mutationResult) => updateCommandCache(current, mutationResult.command),
      );
      draftRevision.current = result.command.revision;
      setActive(result.command.enabled);
    } catch {
      notify({ tone: "error", message: labels.saveError });
    } finally { setActivePending(false); }
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
      <TextArea
        id={`command-${field}`}
        name={field}
        label={field === "text" ? draft.kind === "timeout" ? labels.responseOptional : labels.response : label}
        hint={hint}
        value={value}
        onChange={(next) => { setTemplateField(field, next); }}
        maxLength={500}
        variables={templateVariables(field)}
        preview={(template, values) => renderTemplate(template, values)}
        previewLabel={labels.previewLabel}
        previewSpeaker={labels.previewSpeaker}
        disabled={!canManageContent || pending}
        messages={labels.textAreaMessages}
        createVariableHref={`/channels/${encodeURIComponent(channelId)}/variables`}
        required={field === "text" && draft.kind !== "timeout" && draft.variableAction === null}
        {...(field === "text" && responseFieldError !== undefined ? { error: responseFieldError } : {})}
        {...(field === "timeoutFallbackText" && timeoutFallbackError !== undefined ? { error: timeoutFallbackError } : {})}
      />
      {field === "text" ? <div className="command-slash-help" aria-live="polite" style={{ height: "calc(var(--s10) * 5)", overflowY: "auto" }}>
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
      <div className="command-library-picker" data-testid="command-library-picker-slot" aria-hidden={libraryBlocks.length === 0 || undefined} style={libraryBlocks.length === 0 ? { visibility: "hidden" } : undefined}>
        <Select label={labels.libraryText} value={selectedLibraryBlock || null} placeholder={labels.libraryTextPlaceholder} options={libraryBlocks.map((name) => ({ value: name, label: `{${name}}` }))} disabled={!canManageContent || pending || libraryBlocks.length === 0} onChange={(name) => setSelectedLibraryBlock(name ?? "")} />
        <Button disabled={!canManageContent || pending || libraryBlocks.length === 0 || selectedLibraryBlock.length === 0} onClick={() => {
          const insertion = `{${selectedLibraryBlock}}`;
          setTemplateField(field, `${value}${value.length === 0 || /\s$/u.test(value) ? "" : " "}${insertion}`);
        }}>{labels.insertLibraryText}</Button>
      </div>
    </div>;
  };

  const sections = [
    {
      id: "settings",
      label: "",
      icon: "tabSettings" as const,
      ...(settingsIssue === undefined ? {} : { issue: settingsIssue }),
      content: <>
        <LoadState
          status={registeredVariablesQuery.data === undefined ? registeredVariablesQuery.isPending ? "loading" : "error" : "success"}
          minHeight="var(--s6)"
          loading={<div />}
          empty={<div />}
          error={<p className="muted" role="alert" style={{ height: "var(--s6)", overflow: "hidden", margin: 0, whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{labels.templateVariablesLoadError}</p>}
          onRetry={() => { void registeredVariablesQuery.refetch(); }}
          refreshError={registeredVariablesQuery.isRefetchError}
        >{null}</LoadState>
        <Field
          id="command-name"
          label={labels.name}
          hint={labels.nameHint}
          prefix="!"
          normalize={normalizeCommandName}
          maxLength={32}
          countLabel={(count, maximum) => `${String(count)} ${language === "en" ? "of" : "von"} ${String(maximum)}`}
          value={draft.name}
          {...(nameError === undefined ? {} : { error: nameError })}
          required
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("name", value); }}
        />
        <TagInput
          id="command-aliases"
          label={labels.aliases}
          hint={labels.aliasHint}
          value={draft.aliases}
          onChange={(value) => { setDraftField("aliases", value); }}
          prefix="!"
          normalize={normalizeCommandName}
          validate={(alias) => !validCommandName(alias) ? labels.aliasInvalid(alias) : alias === normalizedName ? labels.aliasIsName : null}
          maxTags={TEXT_COMMAND_MAX_ALIASES}
          {...(aliasesError === undefined ? {} : { error: aliasesError })}
          invalidValues={[fieldError?.field === "aliases" ? fieldError.invalidAlias ?? "" : "", ...(sameNameAlias ? [normalizedName] : []), ...(invalidAlias === undefined ? [] : [invalidAlias])].filter(Boolean)}
          removeLabel={labels.aliasRemove}
          messages={labels.tagInputMessages}
          listLabel={labels.aliasList}
          disabled={!canManageContent || pending}
        />
        <Select
          label={labels.kind}
          hint={labels.kindHints[draft.kind]}
          value={draft.kind}
          options={kindOptions}
          disabled={!canManageContent || pending}
          onChange={(value) => { if (value !== null) changeKind(value as TextCommandKind); }}
        />
        <div data-testid="command-timeout-settings-slot" style={{ height: "calc(var(--s10) * 6)", overflowY: "auto" }}>
          {draft.kind === "timeout" && draft.timeoutAction !== null ? <div className="command-timeout-action">
            <InspectorSection title={labels.timeoutDuration}>
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
                {...(attemptedSave && timeoutRangeInvalid ? { error: labels.timeoutRangeInvalid } : {})}
                disabled={!canManageContent || pending}
              />
            </InspectorSection>
            <Field
              id="command-timeout-reason"
              label={labels.timeoutReason}
              hint={labels.timeoutReasonHint}
              value={draft.timeoutAction.reason}
              maxLength={500}
              {...(timeoutReasonError === undefined ? {} : { error: timeoutReasonError })}
              countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
              disabled={!canManageContent || pending}
              onChange={(reason) => {
                const timeoutAction = draft.timeoutAction;
                if (timeoutAction !== null) setDraftField("timeoutAction", { ...timeoutAction, reason });
              }}
            />
          </div> : null}
        </div>
        {draft.kind === "list"
          ? <ChatPreview label={labels.previewLabel} speaker={labels.previewSpeaker} text={listPreview} countLabel={labels.textAreaMessages.previewCountLabel(listPreview.length)} />
          : templateEditor("text", draft.kind === "timeout" ? labels.responseOptional : labels.response)}
        <div data-testid="command-timeout-fallback-slot" style={{ height: "calc(var(--s10) * 6)", overflowY: "auto" }}>
          {draft.kind === "timeout" && draft.timeoutAction !== null ? <div className="command-timeout-action">
            {templateEditor("timeoutFallbackText", labels.timeoutFallbackTextOptional)}
            <p className="form-warning" role="note" style={{ minHeight: "var(--s6)", margin: 0 }}>{botIsModerator === false ? labels.timeoutBotWarning : ""}</p>
          </div> : null}
        </div>
        {draft.kind !== "list" ? <details className="command-usage-advanced">
          <summary>{labels.usageAdvanced}</summary>
          <div className="command-usage-advanced__body">
            {templateEditor("usageText", labels.templateFieldLabels.usageText, labels.usageTextHint)}
            {draft.kind === "shoutout" ? <p className="muted command-shoutout-hint">{labels.shoutoutCooldownHint}</p> : null}
            {draft.kind === "timeout" ? <>
              {variableActionEditor}
              {responseTypeEditor}
              {chatTargetEditor}
            </> : null}
          </div>
        </details> : null}
        {draft.kind === "text" ? variableActionEditor : null}
        {draft.kind !== "timeout" ? <>{responseTypeEditor}{chatTargetEditor}</> : null}
      </>,
    },
    {
      id: "advanced",
      label: "",
      icon: "tabAdvanced" as const,
      ...(advancedIssue === undefined ? {} : { issue: advancedIssue }),
      content: <>
        <ChoiceCards
          label={labels.minimumTier}
          hint={labels.tierHelp}
          value={draft.minimumTier}
          options={tierOptions}
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("minimumTier", value as TextCommandMinimumTier); }}
        />
        <InspectorSection title={labels.availability}>
          <InspectorFieldRow label={labels.streamCondition} help={labels.streamHints[draft.streamCondition]}>
            <SegmentedControl
              label={labels.streamCondition}
              hint={labels.streamHints[draft.streamCondition]}
              value={draft.streamCondition}
              options={(["any", "online", "offline"] as const).map((value) => ({ value, label: labels.streamLabels[value] }))}
              disabled={!canManageContent || pending}
              onChange={(value) => { setDraftField("streamCondition", value as TextCommandStreamCondition); }}
            />
          </InspectorFieldRow>
          <InspectorFieldRow label={labels.gameFilter} help={labels.gameFilterHint}>
            <GamePicker
              searchGames={searchGames}
              value={draft.games}
              onChange={(games) => { setDraftField("games", games); }}
              messages={{ ...labels.gamePicker, label: labels.gameFilter, hint: labels.gameFilterHint }}
              disabled={!canManageContent || pending}
            />
          </InspectorFieldRow>
        </InspectorSection>
        <FieldPair>
          <NumberField
            id="command-cooldown"
            label={labels.cooldown}
            hint={labels.cooldownHint}
            unit="s"
            min={0}
            max={86400}
            step={5}
            value={draft.cooldownSeconds}
            {...(attemptedSave && cooldownInvalid ? { error: labels.numberMissing } : {})}
            increaseLabel={`${labels.cooldown} +`}
            decreaseLabel={`${labels.cooldown} −`}
            disabled={!canManageContent || pending}
            onChange={(value) => { setDraftField("cooldownSeconds", value); }}
          />
          <NumberField
            id="command-user-cooldown"
            label={labels.userCooldown}
            hint={labels.userCooldownHint}
            unit="s"
            min={0}
            max={86400}
            step={5}
            value={draft.userCooldownSeconds}
            {...(attemptedSave && userCooldownInvalid ? { error: labels.numberMissing } : {})}
            increaseLabel={`${labels.userCooldown} +`}
            decreaseLabel={`${labels.userCooldown} −`}
            disabled={!canManageContent || pending}
            onChange={(value) => { setDraftField("userCooldownSeconds", value); }}
          />
        </FieldPair>
      </>,
    },
  ];

  const props = useMemo(() => ({
    aliases: draft.aliases,
    kind: labels.kindLabels[draft.kind],
    text: draft.text,
    responseType: labels.responseTypeLabels[draft.responseType],
    chatTarget: labels.chatTargetLabels[draft.chatTarget],
    minimumTier: labels.tierLabels[draft.minimumTier],
    minimumDescription: tierDescription(draft.minimumTier, labels),
    stream: draft.streamCondition === "any" ? labels.streamAny : draft.streamCondition === "online" ? labels.streamOnline : labels.streamOffline,
    games: draft.games.map((game) => game.name).join(", ") || labels.streamAny,
    cooldown: draft.cooldownSeconds === "" ? "—" : `${String(draft.cooldownSeconds)} s`,
    userCooldown: draft.userCooldownSeconds === 0 ? labels.cooldownOff : draft.userCooldownSeconds === "" ? "—" : `${String(draft.userCooldownSeconds)} s`,
  }), [draft, labels]);
  const templateView = (field: CommandTemplateField): ReactElement =>
    <TemplateText value={templateValue(field)} variables={templateVariables(field)} />;

  const propertyList = <dl className="properties command-properties">
    <div><dt>{labels.name}</dt><dd className="mono">!{draft.name}</dd></div>
    <div><dt>{labels.active}</dt><dd><Switch ariaLabel={labels.active} hint={labels.activeImmediately} checked={active} pending={activePending} onChange={(next) => { void toggleActive(next); }} layout="inline" /></dd></div>
    <div><dt>{labels.aliases}</dt><dd className="mono">{props.aliases.length === 0 ? labels.noAliases : props.aliases.map((alias) => `!${alias}`).join(", ")}</dd></div>
    <div><dt>{labels.kind}</dt><dd>{props.kind}</dd></div>
    <div><dt>{labels.response}</dt><dd>{draft.kind === "list" ? <TemplateText value={listPreview} variables={[]} /> : templateView("text")}</dd></div>
    {draft.kind !== "list" && draft.usageText.length > 0 ? <div><dt>{labels.templateFieldLabels.usageText}</dt><dd>{templateView("usageText")}</dd></div> : null}
    <div><dt>{labels.variableAction}</dt><dd>{variableAction === null ? labels.variableNone : `${variableAction.name} ${labels.variableOperations[variableAction.operation]}${variableAction.operation === "set_argument" ? "" : String(variableAction.amount ?? 0)}`}</dd></div>
    <div><dt>{labels.timeoutAction}</dt><dd>{draft.timeoutAction === null
      ? labels.timeoutNone
      : draft.timeoutAction.minSeconds === draft.timeoutAction.maxSeconds
        ? `${String(draft.timeoutAction.minSeconds)} s`
        : `${String(draft.timeoutAction.minSeconds)}–${String(draft.timeoutAction.maxSeconds)} s`}</dd></div>
    {draft.timeoutAction?.reason ? <div><dt>{labels.timeoutReason}</dt><dd>{draft.timeoutAction.reason}</dd></div> : null}
    {draft.timeoutAction === null ? null : <div><dt>{labels.timeoutFallbackText}</dt><dd>{templateView("timeoutFallbackText")}</dd></div>}
    {draft.kind === "shoutout" ? null : <div><dt>{labels.responseType}</dt><dd>{props.responseType}</dd></div>}
    <div><dt>{labels.chatTarget}</dt><dd>{props.chatTarget}</dd></div>
    <div><dt>{labels.minimumTier}</dt><dd>{props.minimumTier} · {props.minimumDescription}</dd></div>
    <div><dt>{labels.streamCondition}</dt><dd>{props.stream}</dd></div>
    <div><dt>{labels.gameFilter}</dt><dd>{props.games}</dd></div>
    <div><dt>{labels.cooldown}</dt><dd className="mono">{props.cooldown}</dd></div>
    <div><dt>{labels.userCooldown}</dt><dd className="mono">{props.userCooldown}</dd></div>
    {command === null ? null : <>
      <div><dt>{labels.lastUsed}</dt><dd className="mono">{relativeTime(command.lastUsedAt, labels)}</dd></div>
      <div><dt>{labels.createdAt}</dt><dd>{formatDate(command.createdAt, resolvedLanguage)}</dd></div>
      <div><dt>{labels.updatedAt}</dt><dd>{formatDate(command.updatedAt, resolvedLanguage)}</dd></div>
    </>}
  </dl>;

  const deleteButton = command === null ? undefined : <Button icon="remove" danger="subtle" disabled={!canManageContent} {...(!canManageContent ? { title: labels.managementLocked } : {})} onClick={() => { setDeleteError(undefined); setConfirmingDelete(true); }}>{labels.delete}</Button>;
  return <>
    <EditorShell
      className="command-editor-shell"
      ariaLabel={isCreate ? labels.add : labels.details(command.name)}
      title={isCreate ? labels.add : <span className="mono">!{command.name}</span>}
      {...(command === null ? {} : { identifier: command.name })}
      meta={command === null ? undefined : <span className="command-inspector__meta">{labels.lastUsed}: {relativeTime(command.lastUsedAt, labels)}</span>}
      sections={sections.map((section) => ({ ...section, label: section.id === "settings" ? labels.tabs.settings : labels.tabs.advanced }))}
      {...(canManageContent ? {} : { readOnly: { reason: labels.managementLocked, content: propertyList } })}
      dirty={dirty}
      pending={pending}
      saved={saved}
      invalid={!valid}
      invalidMessage={labels.invalid}
      invalidFields={invalidFields}
      onInvalidSave={() => { setAttemptedSave(true); }}
      warnings={warnings}
      warningStatusLabel={(items, justSaved) => justSaved ? `✓ ${labels.saved} ${items.join(" ")}` : items.join(" ")}
      {...(concurrentConflict ? { conflict: {
        message: reloadError ? `${labels.conflictMessage} ${labels.reloadError}` : labels.conflictMessage,
        reloadLabel: reloadError ? labels.retry : labels.reload,
        onReload: () => { void reloadServer(); },
      } } : {})}
      onSave={() => { void handleSave(); }}
      onDiscard={() => { reset(); setAttemptedSave(false); setSaved(false); setFieldError(null); setDeleteError(undefined); setServerWarnings([]); }}
      saveLabel={isCreate ? labels.create : labels.save}
      discardLabel={labels.discard}
      savedLabel={labels.saved}
      pendingLabel={labels.pending}
      issueLabels={{ error: labels.issueError, warning: labels.issueWarning }}
      {...(isCreate || deleteButton === undefined ? {} : { destructive: deleteButton })}
      onClose={onClose}
      closeLabel={labels.close}
    />
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.draftGuardTitle}
      description={labels.draftGuardDescription}
      cancelLabel={labels.continueEditing}
      confirmLabel={labels.discardAndSwitch}
      onCancel={guard.continueEditing}
      onConfirm={guard.discardAndSwitch}
      {...(valid ? { alternative: { label: labels.saveAndSwitch, onClick: () => { void guard.saveAndSwitch(); } } } : {})}
      pending={guard.saving}
      danger
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
    />
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
  </>;
};

export const TextCommandsPanel = (props: {
  channelId: string;
  language?: DashboardLanguage | undefined;
  canManage?: boolean;
  botIsModerator?: boolean | null;
  onCloseInspector?: () => void;
  initialSelection?: string;
}): ReactElement => <TextCommandsPanelContent key={props.channelId} {...props} />;

const TextCommandsPanelContent = ({
  channelId,
  language,
  canManage: canManageContent = true,
  botIsModerator = null,
  onCloseInspector,
  initialSelection,
}: {
  channelId: string;
  language?: DashboardLanguage | undefined;
  canManage?: boolean;
  botIsModerator?: boolean | null;
  onCloseInspector?: () => void;
  initialSelection?: string;
}): ReactElement => {
  const labels = textCommandsTexts(language);
  const resolvedLanguage = language ?? dashboardLanguage();
  const common = dashboardCommonTexts(resolvedLanguage);
  const queryClient = useDashboardQueryClient();
  const commandsQuery = useModuleQuery(channelId, "text_commands", "commands", (signal) => loadTextCommandData(channelId, signal));
  const refetchCommands = commandsQuery.refetch;
  const commands = useMemo(() => commandsQuery.data?.commands ?? [], [commandsQuery.data]);
  const [search, setSearch] = useState("");
  const channelVariables = commandsQuery.data?.variables ?? [];
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useInspectorSelection<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [toggleBusyName, setToggleBusyName] = useState<string | null>(null);
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
  const onSaved = useCallback((token: number, name: string): void => {
    if (token !== generationRef.current) return;
    generationRef.current += 1;
    setCreateOpen(false);
    selectName(name);
  }, [selectName]);

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
    if (commandsQuery.isPending || initialSelectionApplied.current || initialSelection === undefined || !commands.some((command) => command.name === initialSelection)) return;
    initialSelectionApplied.current = true;
    guardSwitch(() => { generationRef.current += 1; selectName(initialSelection); });
  }, [commands, commandsQuery.isPending, guardSwitch, initialSelection, selectName]);

  const selected = useMemo(() => commands.find((command) => command.name === selectedName) ?? null, [commands, selectedName]);
  const closeInspector = useCallback((): void => {
    guardSwitch(() => {
      generationRef.current += 1;
      setCreateOpen(false);
      closeSelection();
      onCloseInspector?.();
    });
  }, [closeSelection, guardSwitch, onCloseInspector]);
  const closeCreate = useCallback((): void => {
    guardSwitch(() => { generationRef.current += 1; setCreateOpen(false); });
  }, [guardSwitch]);
  const openCreate = (): void => guardSwitch(() => {
    generationRef.current += 1;
    closeSelection();
    setCreateOpen(true);
  });
  const selectCommand = (name: string): void => guardSwitch(() => {
    generationRef.current += 1;
    setCreateOpen(false);
    selectName(name);
  });
  const toggle = async (command: TextCommand): Promise<void> => {
    setToggleBusyName(command.name);
    try {
      await write(
        command.revision,
        (revision) => toggleTextCommand(channelId, command.name, requireCommandRevision(revision), !command.enabled),
        (current, result) => updateCommandCache(current, result.command),
      );
    }
    catch { notify({ tone: "error", message: labels.saveError }); }
    finally { setToggleBusyName(null); }
  };
  const handleDeleted = (token: number): void => {
    if (token !== generationRef.current) return;
    generationRef.current += 1;
    setCreateOpen(false);
    closeSelection();
  };

  const query = search.trim().toLocaleLowerCase();
  const visibleCommands = useMemo(() => query.length === 0 ? commands : commands.filter((command) => [
    command.name,
    ...command.aliases,
    command.text,
    command.usageText ?? "",
    labels.kindLabels[command.kind],
  ].some((value) => value.toLocaleLowerCase().includes(query))), [commands, labels.kindLabels, query]);
  const listStatus = commandsQuery.data === undefined
    ? commandsQuery.isPending ? "loading" : "error"
    : visibleCommands.length === 0 ? "empty" : "success";
  const createReason = canManageContent ? undefined : labels.managementLocked;
  const list = <section className="command-list config-section" aria-label={labels.list}>
    <div className="section-heading">
      <h2>{labels.list}</h2>
    </div>
    <ListToolbar
      language={resolvedLanguage}
      searchLabel={labels.search}
      searchPlaceholder={labels.search}
      searchClearLabel={common.clearSearch}
      searchValue={search}
      onSearchChange={setSearch}
      create={{ label: labels.add, onClick: openCreate, disabled: !canManageContent, ...(createReason === undefined ? {} : { reason: createReason }) }}
      usage={{
        count: commands.length,
        ...(query.length === 0 ? {} : { filteredCount: visibleCommands.length }),
        copy: { countSuffix: labels.countSuffix, filteredInfix: common.of, filteredSuffix: labels.filteredSuffix, limitInfix: common.of, limitSuffix: "", loadedSuffix: common.loaded },
      }}
      {...(query.length === 0 ? {} : { activeFilters: `${labels.search}: ${search.trim()}`, activeFiltersLabel: labels.activeFilters, resetLabel: labels.resetFilters, onReset: () => { setSearch(""); } })}
    />
    <LoadState status={listStatus} minHeight="calc(var(--s10) * 15)"
      loading={<Skeleton rows={8} height={34} />}
      empty={<p className="empty-state">{commands.length > 0 ? common.noMatches : labels.empty}</p>}
      error={<p className="muted">{labels.loadError}</p>}
      onRetry={() => { void refetchCommands(); }}
      refreshError={commandsQuery.isRefetchError}>
      <div className="table-wrap" style={{ maxHeight: "calc(var(--s10) * 15)", overflowY: "auto" }}><table className="table"><thead><tr>
        <th scope="col">{labels.columns.name}</th><th scope="col">{labels.columns.kind}</th><th scope="col">{labels.columns.response}</th><th scope="col">{labels.columns.minimumTier}</th><th scope="col">{labels.columns.active}</th>
      </tr></thead><tbody>{visibleCommands.map((command) => <TextCommandRow
        key={command.name}
        initial={command}
        language={resolvedLanguage}
        selected={selectedName === command.name}
        onSelect={() => { selectCommand(command.name); }}
        rowRef={rowRef(command.name)}
        toggleBusy={toggleBusyName === command.name}
        onToggle={() => toggle(command)}
      />)}</tbody></table></div>
    </LoadState>
  </section>;

  const inspector = selected !== null ? <TextCommandEditor
    key={selected.name}
    channelId={channelId}
    language={language}
    initial={draftFromCommand(selected)}
    command={selected}
    commands={commands}
    channelVariables={channelVariables}
    canManageContent={canManageContent}
    botIsModerator={botIsModerator}
    onClose={closeInspector}
    onGuardChange={registerGuard}
    onRefresh={refresh}
    onSaved={onSaved}
    generation={generation}
    onWrite={write}
    onDeleted={handleDeleted}
  /> : createOpen ? <TextCommandEditor
    key="create"
    channelId={channelId}
    language={language}
    initial={newCommandDraft()}
    command={null}
    commands={commands}
    channelVariables={channelVariables}
    canManageContent={canManageContent}
    botIsModerator={botIsModerator}
    onClose={closeCreate}
    onGuardChange={registerGuard}
    onRefresh={refresh}
    onSaved={onSaved}
    generation={generation}
    onWrite={write}
    onDeleted={handleDeleted}
  /> : null;

  return <section className="module-stack command-panel" aria-label={labels.title}>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
  </section>;
};

export default TextCommandsPanel;
