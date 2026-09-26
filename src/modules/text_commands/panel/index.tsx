import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";
import {
  Button, ChatPreview, ChoiceCards, ConfirmDialog, EditorShell, Field, FieldPair, GamePicker, ListDetail, NumberField, Select,
  registerDashboardNavigationGuard, SegmentedControl, Switch, TagInput, TemplateText, TextArea, useDraft, useDraftGuard, useInspectorSelection,
} from "../../../dashboard/ui";
import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_COMMAND_KINDS, TEXT_COMMAND_MAX_ALIASES, TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TEMPLATE_FIELDS, type TextCommand, type TextCommandGame, type TextCommandKind, type TextCommandMinimumTier, type TextCommandResponseType, type TextCommandStreamCondition } from "../contracts";
import { minimumTierAfterVariableOperation } from "./editor-state";
import { commandListReply, TEXT_COMMAND_DEFAULT_USAGE_TEXT, textCommandDefaultsFor } from "../contracts/chat-defaults";
import { statusForTier, validCommandName } from "../domain";
import { invalidTemplateParameters, renderTemplate, templateVariableNames, unknownTemplateVariables, worstCaseTemplateLength, type PanelTemplateWarning, type TemplateVariable } from "../contract";
import { effectivePanelTemplateVariables, panelTemplateOptions } from "../../../dashboard/ui";
import { createTextCommand, deleteTextCommand, loadTextCommandData, loadTextLibraryBlocks, saveTextCommand, searchTextGames, setTextCommandMinimumTier, toggleTextCommand, type TextCommandChannelVariable } from "./service";
import { textCommandsTexts } from "./locale";

const normalizeCommandName = (name: string): string => name.trim().replace(/^!/u, "").toLowerCase();

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
  variableAction: TextCommand["variableAction"];
}

const draftFromCommand = (command: TextCommand): CommandDraft => ({
  name: command.name,
  text: command.text,
  usageText: command.usageText ?? TEXT_COMMAND_DEFAULT_USAGE_TEXT,
  kind: command.kind,
  minimumTier: command.minimumTier,
  cooldownSeconds: command.cooldownSeconds,
  aliases: [...command.aliases],
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  games: [...(command.games ?? [])],
  responseType: command.responseType,
  variableAction: command.variableAction === null ? null : { ...command.variableAction },
});

const newCommandDraft = (): CommandDraft => ({
  name: "",
  text: "",
  usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT,
  kind: "text",
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  games: [],
  responseType: "say",
  variableAction: null,
});

type CommandTemplateField = "text" | "usageText";

const templateFieldsForKind = (kind: TextCommandKind, channelVariables: readonly TextCommandChannelVariable[]): Readonly<Record<string, readonly TemplateVariable[]>> => {
  const fields = TEXT_COMMAND_TEMPLATE_FIELDS[kind] as Readonly<Record<string, readonly TemplateVariable[]>>;
  const effective = effectivePanelTemplateVariables("chat_command", [], channelVariables);
  return Object.fromEntries(Object.keys(fields).map((key) => [key, effective]));
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
  canManageContent: boolean;
  toggleBusy: boolean;
  onToggle: () => Promise<void>;
  minimumBusy: boolean;
  onMinimumChange: (minimumTier: TextCommandMinimumTier) => Promise<void>;
}

const TextCommandRow = ({ initial, language, selected, onSelect, rowRef, canManageContent, toggleBusy, onToggle, minimumBusy, onMinimumChange }: TextCommandRowProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  return (
    <tr ref={rowRef} tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td>{labels.kindLabels[initial.kind]}</td>
      <td className={`table__answer${initial.text.length === 0 && initial.variableAction !== null ? " table__answer--placeholder" : ""}`} title={initial.kind === "list" ? undefined : initial.text}>
        {initial.kind === "list" ? "—" : initial.text.length > 0 ? initial.text : initial.variableAction === null ? "—" : labels.actionResponse(initial.variableAction.name, initial.variableAction.operation, initial.variableAction.amount)}
      </td>
      <td>
        <div className="minimum-tier-select" onClick={(event) => { event.stopPropagation(); }} onKeyDown={(event) => { event.stopPropagation(); }}>
          <Select
            ariaLabel={`${labels.minimumTier}: !${initial.name}`}
            value={initial.minimumTier}
            disabled={!canManageContent || minimumBusy}
            busy={minimumBusy}
            {...(canManageContent ? {} : { title: labels.minimumTierLocked })}
            options={TEXT_COMMAND_MINIMUM_TIERS.map((tier) => ({ value: tier, label: labels.tierLabels[tier] }))}
            onChange={(value) => { if (value !== null) void onMinimumChange(value as TextCommandMinimumTier); }}
          />
        </div>
      </td>
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
  onCreateSuccess?: () => void;
  onGuardChange: (guard: ((proceed: () => void, cancel?: () => void) => void) | null) => void;
  onRefresh: (selectName?: string) => Promise<TextCommand[]>;
  onDeleted: () => Promise<void>;
}

const TextCommandEditor = ({ channelId, language, initial, command, commands, channelVariables, canManageContent, botIsModerator, onClose, onCreateSuccess, onGuardChange, onRefresh, onDeleted }: TextCommandEditorProperties): ReactElement => {
  const labels = useMemo(() => textCommandsTexts(language), [language]);
  const searchGames = useCallback((query: string) => searchTextGames(channelId, query), [channelId]);
  const resolvedLanguage = language ?? dashboardLanguage();
  const { value: draft, setValue, dirty, reset, accept } = useDraft<CommandDraft>(initial);
  const draftRevision = useRef(command?.revision ?? null);
  const [active, setActive] = useState(command?.enabled ?? true);
  const [activePending, setActivePending] = useState(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fieldError, setFieldError] = useState<{ field: "name" | "aliases"; message: string; invalidAlias?: string } | null>(null);
  const [concurrentConflict, setConcurrentConflict] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [serverWarnings, setServerWarnings] = useState<readonly PanelTemplateWarning[]>([]);
  const [minimumTierExplicit, setMinimumTierExplicit] = useState(false);
  const [libraryBlocks, setLibraryBlocks] = useState<readonly string[]>([]);
  const [selectedLibraryBlock, setSelectedLibraryBlock] = useState("");
  const isCreate = command === null;
  const blockVariables: TemplateVariable[] = libraryBlocks.map((name) => ({ name, group: "channel", sample: name, maxLength: 500 }));
  const baseTemplateFields = templateFieldsForKind(draft.kind, channelVariables);
  const templateFields = Object.fromEntries(Object.entries(baseTemplateFields).map(([field, variables]) => [field, [...variables, ...blockVariables]]));
  const variableAction = draft.variableAction;
  const templateVariables = () => [
    ...panelTemplateOptions("chat_command", [], channelVariables, resolvedLanguage),
    ...libraryBlocks.map((name) => ({ name, description: labels.libraryText, sample: name, group: "channel" as const, kind: "module" as const })),
  ];
  const templateValue = (field: CommandTemplateField): string => draft[field];
  const normalizedName = normalizeCommandName(draft.name);
  const nameInvalid = normalizedName.length === 0 || !validCommandName(normalizedName);
  const sameNameAlias = draft.aliases.includes(normalizedName);
  const nameError = fieldError?.field === "name" ? fieldError.message : attemptedSave && normalizedName.length === 0 ? labels.nameMissing : attemptedSave && !validCommandName(normalizedName) ? labels.nameInvalid : undefined;
  const aliasesError = fieldError?.field === "aliases" ? fieldError.message : sameNameAlias ? labels.aliasIsName : undefined;
  const cooldownInvalid = draft.cooldownSeconds === "" || !Number.isInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 0 || draft.cooldownSeconds > 86400;
  const userCooldownInvalid = draft.userCooldownSeconds === "" || !Number.isInteger(draft.userCooldownSeconds) || draft.userCooldownSeconds < 0 || draft.userCooldownSeconds > 86400;
  const templateFieldNames = Object.keys(templateFields) as CommandTemplateField[];
  const responseInvalid = templateFieldNames.some((field) => {
    const value = templateValue(field);
    return (value.trim().length === 0 && !(field === "text" && draft.variableAction !== null)) || value.length > 500;
  });
  const actionInvalid = draft.variableAction !== null && (!channelVariables.some((variable) => variable.name === draft.variableAction?.name) ||
    ((draft.variableAction.operation === "add" || draft.variableAction.operation === "subtract") && (draft.variableAction.amount === null || draft.variableAction.amount < 1 || draft.variableAction.amount > 1000)) ||
    (draft.variableAction.operation === "set" && (draft.variableAction.amount === null || draft.variableAction.amount < -999999999 || draft.variableAction.amount > 999999999)));
  const valid = !nameInvalid && !sameNameAlias && !cooldownInvalid && !userCooldownInvalid && !responseInvalid && !actionInvalid && draft.aliases.length <= TEXT_COMMAND_MAX_ALIASES;
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
  const advancedIssue = fieldError?.field === "aliases" || cooldownInvalid || userCooldownInvalid
    ? "error" as const
    : undefined;
  const settingsIssue = nameError !== undefined || responseInvalid
    ? "error" as const
    : announcementWarning !== undefined || localWarnings.length > 0 || serverWarnings.length > 0
      ? "warning" as const
      : undefined;
  const listPreview = commandListReply(commands.filter((item) => item.enabled && item.name !== command?.name).map((item) => item.name));

  useEffect(() => {
    let active = true;
    loadTextLibraryBlocks(channelId).then((blocks) => { if (active) setLibraryBlocks(blocks); }).catch(() => { if (active) setLibraryBlocks([]); });
    return () => { active = false; };
  }, [channelId]);

  const saveDraft = useCallback(async (): Promise<string | null> => {
    setAttemptedSave(true);
    if (!canManageContent || !valid) return labels.invalid;
    const payload = {
      name: normalizedName,
      text: draft.kind === "list" ? "" : draft.text,
      kind: draft.kind,
      ...(draft.kind === "shoutout" ? { usageText: draft.usageText } : {}),
      minimumTier: draft.minimumTier,
      cooldownSeconds: draft.cooldownSeconds as number,
      aliases: draft.aliases,
      userCooldownSeconds: draft.userCooldownSeconds as number,
      streamCondition: draft.streamCondition,
      games: draft.games,
      responseType: draft.responseType,
      variableAction: draft.variableAction,
    };
    setPending(true); setError(undefined); setFieldError(null); setConcurrentConflict(false); setSaved(false);
    try {
      const returnedWarnings = isCreate
        ? await createTextCommand(channelId, payload)
        : await saveTextCommand(channelId, { oldName: command.name, revision: draftRevision.current ?? command.revision, ...payload });
      if (!isCreate && draftRevision.current !== null) draftRevision.current += 1;
      accept({ ...draft, ...payload, name: payload.name });
      setServerWarnings(returnedWarnings);
      await onRefresh(payload.name);
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
      setError(labels.saveError);
      return labels.saveError;
    } finally { setPending(false); }
  }, [accept, canManageContent, channelId, command, draft, isCreate, labels, normalizedName, onRefresh, valid, setAttemptedSave, setConcurrentConflict, setError, setFieldError, setPending, setSaved, setServerWarnings]);

  const guard = useDraftGuard(dirty, saveDraft, reset);
  useEffect(() => {
    onGuardChange(guard.guardSwitch);
    return () => { onGuardChange(null); };
  }, [guard.guardSwitch, onGuardChange]);

  const setDraftField = <Key extends keyof CommandDraft>(key: Key, value: CommandDraft[Key]): void => {
    if (key === "minimumTier") setMinimumTierExplicit(true);
    setValue((current) => ({ ...current, [key]: value }));
    setSaved(false); setError(undefined); setConcurrentConflict(false);
    if (key === "name" || key === "aliases") setFieldError(null);
  };

  const changeKind = (kind: TextCommandKind): void => {
    setValue((current) => {
      const defaults = kind === "shoutout" ? textCommandDefaultsFor(kind) : null;
      return {
        ...current,
        kind,
        text: kind === "list" ? "" : defaults?.text ?? (current.kind === "text" ? current.text : ""),
        usageText: current.usageText || defaults?.usageText || TEXT_COMMAND_DEFAULT_USAGE_TEXT,
        ...(isCreate && kind === "shoutout" ? { minimumTier: "moderator" as const } : {}),
      };
    });
    setSaved(false); setError(undefined); setConcurrentConflict(false);
  };

  const handleSave = async (): Promise<void> => {
    if (!valid) { setAttemptedSave(true); return; }
    const result = await saveDraft();
    if (result === null && isCreate) onCreateSuccess?.();
  };

  const reloadServer = async (): Promise<void> => {
    const data = await onRefresh();
    const latest = data.find((item) => item.name === command?.name || item.name === normalizedName);
    if (latest === undefined) { onClose(); return; }
    accept(draftFromCommand(latest));
    draftRevision.current = latest.revision;
    setActive(latest.enabled);
    setConcurrentConflict(false); setFieldError(null); setError(undefined); setServerWarnings([]);
  };

  const toggleActive = async (next: boolean): Promise<void> => {
    if (command === null) return;
    setActivePending(true); setError(undefined);
    try {
      await toggleTextCommand(channelId, command.name, command.revision, next);
      setActive(next);
      await onRefresh(command.name);
    } catch {
      setError(labels.saveError);
    } finally { setActivePending(false); }
  };

  const remove = async (): Promise<void> => {
    if (command === null) return;
    setDeleting(true); setError(undefined);
    try { await deleteTextCommand(channelId, command.name, command.revision); setConfirmingDelete(false); await onDeleted(); }
    catch { setError(labels.deleteError); }
    finally { setDeleting(false); }
  };

  const templateEditor = (field: CommandTemplateField, label: string): ReactElement => {
    const value = templateValue(field);
    return <div className="command-template-editor" key={field}>
      <TextArea
        id={`command-${field}`}
        name={field}
        label={field === "text" ? labels.response : label}
        hint={labels.responseHint}
        value={value}
        onChange={(next) => { setDraftField(field, next); }}
        maxLength={500}
        variables={templateVariables()}
        preview={(template, values) => renderTemplate(template, values)}
        previewLabel={labels.previewLabel}
        previewSpeaker={labels.previewSpeaker}
        disabled={!canManageContent || pending}
        messages={labels.textAreaMessages}
        createVariableHref={`/channels/${encodeURIComponent(channelId)}/variables`}
        required={field !== "text" || draft.variableAction === null}
        {...(attemptedSave && value.trim().length === 0 && !(field === "text" && draft.variableAction !== null) ? { error: labels.responseMissing } : {})}
      />
      <div className="command-library-picker">
        {libraryBlocks.length === 0 ? <p className="muted">{labels.noLibraryTexts}</p> : <>
          <Select label={labels.libraryText} value={selectedLibraryBlock || null} placeholder={labels.libraryTextPlaceholder} options={libraryBlocks.map((name) => ({ value: name, label: `{${name}}` }))} disabled={!canManageContent || pending} onChange={(name) => setSelectedLibraryBlock(name ?? "")} />
          <Button disabled={!canManageContent || pending || selectedLibraryBlock.length === 0} onClick={() => {
            const insertion = `{${selectedLibraryBlock}}`;
            setDraftField(field, `${value}${value.length === 0 || /\s$/u.test(value) ? "" : " "}${insertion}`);
          }}>{labels.insertLibraryText}</Button>
        </>}
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
          label={labels.aliases}
          hint={labels.aliasHint}
          value={draft.aliases}
          onChange={(value) => { setDraftField("aliases", value); }}
          prefix="!"
          normalize={normalizeCommandName}
          validate={(alias) => !validCommandName(alias) ? labels.aliasInvalid(alias) : alias === normalizedName ? labels.aliasIsName : null}
          maxTags={TEXT_COMMAND_MAX_ALIASES}
          {...(aliasesError === undefined ? {} : { error: aliasesError })}
          invalidValues={[fieldError?.field === "aliases" ? fieldError.invalidAlias ?? "" : "", ...(sameNameAlias ? [normalizedName] : [])].filter(Boolean)}
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
        {draft.kind === "list"
          ? <ChatPreview label={labels.previewLabel} speaker={labels.previewSpeaker} text={listPreview} countLabel={labels.textAreaMessages.previewCountLabel(listPreview.length)} />
          : templateEditor("text", labels.response)}
        {draft.kind === "shoutout" ? <>
          {templateEditor("usageText", labels.templateFieldLabels.usageText)}
          <p className="muted command-shoutout-hint">{labels.shoutoutCooldownHint}</p>
        </> : null}
        {draft.kind === "text" ? <>
          <Switch
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
          {variableAction === null ? null : <div className="command-variable-action">
            <Select
              label={labels.variableSelect}
              hint={labels.variableSelectHint}
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
                options={(["add", "subtract", "set", "set_argument"] as const).map((operation) => ({ value: operation, label: labels.variableOperations[operation] }))}
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
                  setSaved(false); setError(undefined); setConcurrentConflict(false);
                }}
              />
              {variableAction.operation === "set_argument" ? null : <NumberField
                id="command-variable-amount"
                label={labels.variableAmount}
                hint={labels.variableOperationHelp[variableAction.operation]}
                min={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1 : -999999999}
                max={variableAction.operation === "add" || variableAction.operation === "subtract" ? 1000 : 999999999}
                step={1}
                increaseLabel={labels.variableAmount}
                decreaseLabel={labels.variableAmount}
                value={variableAction.amount ?? ""}
                disabled={!canManageContent || pending}
                onChange={(amount) => setDraftField("variableAction", { ...variableAction, amount: amount === "" ? null : amount })}
              />}
            </FieldPair>
            {channelVariables.length === 0 ? <p className="muted">{labels.variableNone} <a href={`/channels/${encodeURIComponent(channelId)}/variables`}>{labels.createVariable}</a></p> : null}
            {variableAction.operation === "set_argument" && draft.minimumTier === "everyone" ? <p className="form-warning" role="note">{labels.variableEveryoneWarning}</p> : null}
            {draft.text.trim().length === 0 ? <p className="muted">{labels.variableSilentHint}</p> : null}
          </div>}
          </Switch>
        </> : null}
        {draft.kind === "shoutout" ? null : <SegmentedControl
          label={labels.responseType}
          hint={labels.responseTypeHints[draft.responseType]}
          value={draft.responseType}
          options={(["say", "reply", "announcement"] as const).map((value) => ({ value, label: labels.responseTypeLabels[value] }))}
          {...(announcementWarning === undefined ? {} : { warning: announcementWarning })}
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("responseType", value as TextCommandResponseType); }}
        />}
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
        <SegmentedControl
          label={labels.streamCondition}
          hint={labels.streamHints[draft.streamCondition]}
          value={draft.streamCondition}
          options={(["any", "online", "offline"] as const).map((value) => ({ value, label: labels.streamLabels[value] }))}
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("streamCondition", value as TextCommandStreamCondition); }}
        />
        <GamePicker
          searchGames={searchGames}
          value={draft.games}
          onChange={(games) => { setDraftField("games", games); }}
          messages={{ ...labels.gamePicker, label: labels.gameFilter, hint: labels.gameFilterHint }}
          disabled={!canManageContent || pending}
        />
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
    minimumTier: labels.tierLabels[draft.minimumTier],
    minimumDescription: tierDescription(draft.minimumTier, labels),
    stream: draft.streamCondition === "any" ? labels.streamAny : draft.streamCondition === "online" ? labels.streamOnline : labels.streamOffline,
    games: draft.games.map((game) => game.name).join(", ") || labels.streamAny,
    cooldown: draft.cooldownSeconds === "" ? "—" : `${String(draft.cooldownSeconds)} s`,
    userCooldown: draft.userCooldownSeconds === 0 ? labels.cooldownOff : draft.userCooldownSeconds === "" ? "—" : `${String(draft.userCooldownSeconds)} s`,
  }), [draft, labels]);
  const templateView = (field: CommandTemplateField): ReactElement =>
    <TemplateText value={templateValue(field)} variables={templateVariables()} />;

  const propertyList = <dl className="properties command-properties">
    <div><dt>{labels.name}</dt><dd className="mono">!{draft.name}</dd></div>
    <div><dt>{labels.active}</dt><dd><Switch ariaLabel={labels.active} hint={labels.activeImmediately} checked={active} pending={activePending} onChange={(next) => { void toggleActive(next); }} layout="inline" /></dd></div>
    <div><dt>{labels.aliases}</dt><dd className="mono">{props.aliases.length === 0 ? labels.noAliases : props.aliases.map((alias) => `!${alias}`).join(", ")}</dd></div>
    <div><dt>{labels.kind}</dt><dd>{props.kind}</dd></div>
    <div><dt>{labels.response}</dt><dd>{draft.kind === "list" ? <TemplateText value={listPreview} variables={[]} /> : templateView("text")}</dd></div>
    {draft.kind === "shoutout" ? <div><dt>{labels.templateFieldLabels.usageText}</dt><dd>{templateView("usageText")}</dd></div> : null}
    <div><dt>{labels.variableAction}</dt><dd>{variableAction === null ? labels.variableNone : `${variableAction.name} ${labels.variableOperations[variableAction.operation]}${variableAction.operation === "set_argument" ? "" : String(variableAction.amount ?? 0)}`}</dd></div>
    {draft.kind === "shoutout" ? null : <div><dt>{labels.responseType}</dt><dd>{props.responseType}</dd></div>}
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

  const deleteButton = command === null ? undefined : <Button icon="remove" iconOnly ariaLabel={labels.delete} title={labels.delete} danger="subtle" onClick={() => { setConfirmingDelete(true); }} />;
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
      {...(error === undefined ? {} : { error })}
      invalid={!valid}
      invalidMessage={labels.invalid}
      warnings={warnings}
      warningStatusLabel={(items, justSaved) => justSaved ? `✓ ${labels.saved} ${items.join(" ")}` : items.join(" ")}
      {...(concurrentConflict ? { conflict: { message: labels.conflictMessage, reloadLabel: labels.reload, onReload: () => { void reloadServer(); } } } : {})}
      onSave={() => { void handleSave(); }}
      onDiscard={() => { reset(); setAttemptedSave(false); setSaved(false); setFieldError(null); setError(undefined); setServerWarnings([]); }}
      saveLabel={isCreate ? labels.create : labels.save}
      discardLabel={labels.discard}
      savedLabel={labels.saved}
      pendingLabel={labels.pending}
      issueLabels={{ error: labels.issueError, warning: labels.issueWarning }}
      {...(isCreate ? {} : { footer: deleteButton })}
      onClose={onClose}
      closeLabel={labels.close}
    />
    {guard.saveError === undefined ? null : <p className="form-error" role="alert">{guard.saveError}</p>}
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.draftGuardTitle}
      description={guard.saveError === undefined ? labels.draftGuardDescription : `${labels.draftGuardDescription} ${guard.saveError}`}
      cancelLabel={labels.continueEditing}
      confirmLabel={labels.discardAndSwitch}
      onCancel={guard.continueEditing}
      onConfirm={guard.discardAndSwitch}
      {...(valid ? { alternative: { label: labels.saveAndSwitch, onClick: () => { void guard.saveAndSwitch(); } } } : {})}
      pending={guard.saving}
      danger
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
    />
  </>;
};

export const TextCommandsPanel = ({
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
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const [channelVariables, setChannelVariables] = useState<TextCommandChannelVariable[]>([]);
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useInspectorSelection<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusyName, setToggleBusyName] = useState<string | null>(null);
  const [minimumBusyName, setMinimumBusyName] = useState<string | null>(null);
  const guardRef = useRef<((proceed: () => void, cancel?: () => void) => void) | null>(null);
  const guardSwitch = useCallback((proceed: () => void, cancel?: () => void): void => {
    const guard = guardRef.current;
    if (guard === null) proceed();
    else guard(proceed, cancel);
  }, []);
  const registerGuard = useCallback((next: ((proceed: () => void, cancel?: () => void) => void) | null): void => { guardRef.current = next; }, []);
  useEffect(() => registerDashboardNavigationGuard(guardSwitch), [guardSwitch]);
  const initialSelectionApplied = useRef(false);

  const refresh = useCallback(async (selectAfter?: string): Promise<TextCommand[]> => {
    const data = await loadTextCommandData(channelId);
    setCommands(data.commands);
    setChannelVariables(data.variables);
    setError(null);
    if (selectAfter !== undefined && data.commands.some((item) => item.name === selectAfter)) {
      setCreateOpen(false);
      selectName(selectAfter);
    }
    return data.commands;
  }, [channelId, selectName]);

  useEffect(() => {
    let active = true;
    void loadTextCommandData(channelId).then((data) => {
      if (!active) return;
      setCommands(data.commands); setChannelVariables(data.variables); setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(labels.loadError); setLoading(false);
    });
    return () => { active = false; };
  }, [channelId, labels.loadError]);

  useEffect(() => {
    if (loading || initialSelectionApplied.current || initialSelection === undefined || !commands.some((command) => command.name === initialSelection)) return;
    initialSelectionApplied.current = true;
    guardSwitch(() => { selectName(initialSelection); });
  }, [commands, guardSwitch, initialSelection, loading, selectName]);

  const selected = useMemo(() => commands.find((command) => command.name === selectedName) ?? null, [commands, selectedName]);
  const closeInspector = useCallback((): void => {
    guardSwitch(() => {
      setCreateOpen(false);
      closeSelection();
      onCloseInspector?.();
    });
  }, [closeSelection, guardSwitch, onCloseInspector]);
  const closeCreate = useCallback((): void => {
    guardSwitch(() => { setCreateOpen(false); });
  }, [guardSwitch]);
  const finishCreate = useCallback((): void => { setCreateOpen(false); }, []);
  const openCreate = (): void => guardSwitch(() => {
    closeSelection();
    setCreateOpen(true);
  });
  const selectCommand = (name: string): void => guardSwitch(() => {
    setCreateOpen(false);
    selectName(name);
  });
  const toggle = async (command: TextCommand): Promise<void> => {
    setToggleBusyName(command.name); setError(null);
    try { await toggleTextCommand(channelId, command.name, command.revision, !command.enabled); await refresh(); }
    catch { setError(labels.saveError); }
    finally { setToggleBusyName(null); }
  };
  const changeMinimum = async (command: TextCommand, minimumTier: TextCommandMinimumTier): Promise<void> => {
    setMinimumBusyName(command.name); setError(null);
    try { await setTextCommandMinimumTier(channelId, command.name, command.revision, minimumTier); await refresh(); }
    catch { setError(labels.saveError); }
    finally { setMinimumBusyName(null); }
  };
  const handleDeleted = async (): Promise<void> => {
    await refresh();
    setCreateOpen(false);
    closeSelection();
  };

  const list = <section className="command-list config-section" aria-label={labels.list}>
    <div className="section-heading">
      <h2>{labels.list}</h2>
      {canManageContent ? <Button icon="add" iconOnly ariaLabel={labels.add} onClick={openCreate} /> : null}
    </div>
    {loading ? <p className="loading-line">{labels.load}</p> : null}
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    {!loading && error === null && commands.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
    {!loading && error === null && commands.length > 0 ? <div className="table-wrap"><table className="table"><thead><tr>
      <th scope="col">{labels.columns.name}</th><th scope="col">{labels.columns.kind}</th><th scope="col">{labels.columns.response}</th><th scope="col">{labels.columns.minimumTier}</th><th scope="col">{labels.columns.active}</th>
    </tr></thead><tbody>{commands.map((command) => <TextCommandRow
      key={command.name}
      initial={command}
      language={language}
      selected={selectedName === command.name}
      onSelect={() => { selectCommand(command.name); }}
      rowRef={rowRef(command.name)}
      canManageContent={canManageContent}
      toggleBusy={toggleBusyName === command.name}
      onToggle={() => toggle(command)}
      minimumBusy={minimumBusyName === command.name}
      onMinimumChange={(tier) => changeMinimum(command, tier)}
    />)}</tbody></table></div> : null}
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
    onCreateSuccess={finishCreate}
    onGuardChange={registerGuard}
    onRefresh={refresh}
    onDeleted={handleDeleted}
  /> : null;

  return <section className="module-stack command-panel" aria-label={labels.title}>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
  </section>;
};

export default TextCommandsPanel;
