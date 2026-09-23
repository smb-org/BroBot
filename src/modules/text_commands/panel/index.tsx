import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { dashboardLanguage, type DashboardLanguage } from "../../../dashboard/locale";
import {
  Button, ChoiceCards, ConfirmDialog, EditorShell, Field, FieldPair, ListDetail, NumberField, Select,
  SegmentedControl, Switch, TagInput, TemplateText, TextArea, useDraft, useDraftGuard, useInspectorSelection,
} from "../../../dashboard/ui";
import { PanelApiError } from "../../../contracts/panel-error";
import { TEXT_COMMAND_MAX_ALIASES, TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_VARIABLES, type TextCommand, type TextCommandKind, type TextCommandMinimumTier, type TextCommandResponseType, type TextCommandStreamCondition } from "../contracts";
import { commandListReply } from "../contracts/chat-defaults";
import { renderCommandText, statusForTier, validCommandName } from "../domain";
import { worstCaseTemplateLength, type PanelTemplateWarning } from "../contract";
import { createTextCommand, deleteTextCommand, loadTextCommands, saveTextCommand, setTextCommandMinimumTier, toggleTextCommand } from "./service";
import { textCommandsTexts } from "./locale";

const normalizeCommandName = (name: string): string => name.trim().replace(/^!/u, "").toLowerCase();

interface CommandDraft {
  name: string;
  text: string;
  kind: TextCommandKind;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number | "";
  aliases: string[];
  userCooldownSeconds: number | "";
  streamCondition: TextCommandStreamCondition;
  responseType: TextCommandResponseType;
}

const draftFromCommand = (command: TextCommand): CommandDraft => ({
  name: command.name,
  text: command.text,
  kind: command.kind,
  minimumTier: command.minimumTier,
  cooldownSeconds: command.cooldownSeconds,
  aliases: [...command.aliases],
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  responseType: command.responseType,
});

const newCommandDraft = (): CommandDraft => ({
  name: "",
  text: "",
  kind: "text",
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  responseType: "say",
});

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
      <td className="table__answer" title={initial.kind === "text" ? initial.text : undefined}>{initial.kind === "text" ? initial.text : "—"}</td>
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
  canManageContent: boolean;
  botIsModerator: boolean | null;
  onClose: () => void;
  onCreateSuccess?: () => void;
  onGuardChange: (guard: ((proceed: () => void) => void) | null) => void;
  onRefresh: (selectName?: string) => Promise<TextCommand[]>;
  onDeleted: () => Promise<void>;
}

const TextCommandEditor = ({ channelId, language, initial, command, commands, canManageContent, botIsModerator, onClose, onCreateSuccess, onGuardChange, onRefresh, onDeleted }: TextCommandEditorProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  const resolvedLanguage = language ?? dashboardLanguage();
  const { value: draft, setValue, dirty, reset, accept } = useDraft<CommandDraft>(initial);
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
  const [templateIssues, setTemplateIssues] = useState<{ unknown: readonly string[]; worstCaseExceeded: boolean }>({ unknown: [], worstCaseExceeded: false });
  const labelsForVariables = useMemo(() => TEXT_COMMAND_VARIABLES.map((variable) => ({
    name: variable.name,
    sample: variable.sample,
    description: variable.name === "user" ? labels.variables.user : labels.variables.channel,
  })), [labels.variables]);
  const isCreate = command === null;
  const normalizedName = normalizeCommandName(draft.name);
  const nameInvalid = normalizedName.length === 0 || !validCommandName(normalizedName);
  const sameNameAlias = draft.aliases.includes(normalizedName);
  const nameError = fieldError?.field === "name" ? fieldError.message : attemptedSave && normalizedName.length === 0 ? labels.nameMissing : attemptedSave && !validCommandName(normalizedName) ? labels.nameInvalid : undefined;
  const aliasesError = fieldError?.field === "aliases" ? fieldError.message : sameNameAlias ? labels.aliasIsName : undefined;
  const cooldownInvalid = draft.cooldownSeconds === "" || !Number.isInteger(draft.cooldownSeconds) || draft.cooldownSeconds < 0 || draft.cooldownSeconds > 86400;
  const userCooldownInvalid = draft.userCooldownSeconds === "" || !Number.isInteger(draft.userCooldownSeconds) || draft.userCooldownSeconds < 0 || draft.userCooldownSeconds > 86400;
  const responseInvalid = draft.kind === "text" && (draft.text.trim().length === 0 || draft.text.length > 500);
  const valid = !nameInvalid && !sameNameAlias && !cooldownInvalid && !userCooldownInvalid && !responseInvalid && draft.aliases.length <= TEXT_COMMAND_MAX_ALIASES;
  const localWarnings = templateIssues.unknown.length === 0 && !templateIssues.worstCaseExceeded ? [] : [
    ...(templateIssues.unknown.length === 0 ? [] : [labels.warningLabel({ field: "text", code: "unknown_template_variables", unknownVariables: templateIssues.unknown })]),
    ...(templateIssues.worstCaseExceeded ? [labels.warningLabel({ field: "text", code: "template_worst_case_too_long", worstCaseLength: worstCaseTemplateLength(draft.text, TEXT_COMMAND_VARIABLES) })] : []),
  ];
  const warnings = [...serverWarnings.map(labels.warningLabel), ...localWarnings];
  const tierOptions = TEXT_COMMAND_MINIMUM_TIERS.map((tier) => ({
    value: tier,
    label: labels.tierLabels[tier],
    description: tierDescription(tier, labels),
    icon: `tier${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}` as "tierEveryone" | "tierSubscriber" | "tierVip" | "tierModerator" | "tierBroadcaster",
  }));
  const announcementWarning = draft.responseType === "announcement" && botIsModerator === false ? labels.announcementWarning : undefined;
  const advancedIssue = fieldError?.field === "aliases" || cooldownInvalid || userCooldownInvalid
    ? "error" as const
    : undefined;
  const settingsIssue = nameError !== undefined || responseInvalid
    ? "error" as const
    : announcementWarning !== undefined || templateIssues.unknown.length > 0 || templateIssues.worstCaseExceeded || serverWarnings.some((warning) => warning.field === "text")
      ? "warning" as const
      : undefined;
  const listPreview = commandListReply(commands.filter((item) => item.enabled && item.name !== command?.name).map((item) => item.name));

  const saveDraft = useCallback(async (): Promise<string | null> => {
    setAttemptedSave(true);
    if (!canManageContent || !valid) return labels.invalid;
    const payload = {
      name: normalizedName,
      text: draft.kind === "list" ? "" : draft.text,
      kind: draft.kind,
      minimumTier: draft.minimumTier,
      cooldownSeconds: draft.cooldownSeconds as number,
      aliases: draft.aliases,
      userCooldownSeconds: draft.userCooldownSeconds as number,
      streamCondition: draft.streamCondition,
      responseType: draft.responseType,
    };
    setPending(true); setError(undefined); setFieldError(null); setConcurrentConflict(false); setSaved(false);
    try {
      const returnedWarnings = isCreate
        ? await createTextCommand(channelId, payload)
        : await saveTextCommand(channelId, { oldName: command.name, ...payload });
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
    setValue((current) => ({ ...current, [key]: value }));
    setSaved(false); setError(undefined); setConcurrentConflict(false);
    if (key === "name" || key === "aliases") setFieldError(null);
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
    setActive(latest.enabled);
    setConcurrentConflict(false); setFieldError(null); setError(undefined); setServerWarnings([]); setTemplateIssues({ unknown: [], worstCaseExceeded: false });
  };

  const toggleActive = async (next: boolean): Promise<void> => {
    if (command === null) return;
    setActivePending(true); setError(undefined);
    try {
      await toggleTextCommand(channelId, command.name, next);
      setActive(next);
      await onRefresh(command.name);
    } catch {
      setError(labels.saveError);
    } finally { setActivePending(false); }
  };

  const remove = async (): Promise<void> => {
    if (command === null) return;
    setDeleting(true); setError(undefined);
    try { await deleteTextCommand(channelId, command.name); setConfirmingDelete(false); await onDeleted(); }
    catch { setError(labels.deleteError); }
    finally { setDeleting(false); }
  };

  const sections = [
    {
      id: "settings",
      label: "",
      icon: "tabSettings" as const,
      ...(settingsIssue === undefined ? {} : { issue: settingsIssue }),
      content: <>
        <div className="command-editor-name-row">
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
          {command === null ? null : <Switch label={labels.active} hint={labels.activeImmediately} checked={active} pending={activePending} onChange={(next) => { void toggleActive(next); }} layout="inline" />}
        </div>
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
        <SegmentedControl
          label={labels.kind}
          hint={labels.kindHints[draft.kind]}
          value={draft.kind}
          options={[{ value: "text", label: labels.kindLabels.text }, { value: "list", label: labels.kindLabels.list }]}
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("kind", value as TextCommandKind); }}
        />
        {draft.kind === "text" ? <TextArea
          id="command-response"
          name="text"
          label={labels.response}
          hint={labels.responseHint}
          value={draft.text}
          onChange={(value) => { setDraftField("text", value); }}
          maxLength={500}
          variables={labelsForVariables}
          preview={(template, values) => renderCommandText(template, values)}
          previewLabel={labels.previewLabel}
          previewSpeaker={labels.previewSpeaker}
          required
          disabled={!canManageContent || pending}
          messages={labels.textAreaMessages}
          onIssuesChange={setTemplateIssues}
          {...(attemptedSave && draft.text.trim().length === 0 ? { error: labels.responseMissing } : {})}
        /> : <div className="command-list-preview"><p>{labels.kindListPreview}</p><TemplateText value={listPreview} variables={[]} /></div>}
        <SegmentedControl
          label={labels.responseType}
          hint={labels.responseTypeHints[draft.responseType]}
          value={draft.responseType}
          options={(["say", "reply", "announcement"] as const).map((value) => ({ value, label: labels.responseTypeLabels[value] }))}
          {...(announcementWarning === undefined ? {} : { warning: announcementWarning })}
          disabled={!canManageContent || pending}
          onChange={(value) => { setDraftField("responseType", value as TextCommandResponseType); }}
        />
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
    cooldown: draft.cooldownSeconds === "" ? "—" : `${String(draft.cooldownSeconds)} s`,
    userCooldown: draft.userCooldownSeconds === 0 ? labels.cooldownOff : draft.userCooldownSeconds === "" ? "—" : `${String(draft.userCooldownSeconds)} s`,
  }), [draft, labels]);

  const propertyList = <dl className="properties command-properties">
    <div><dt>{labels.name}</dt><dd className="mono">!{draft.name}</dd></div>
    <div><dt>{labels.active}</dt><dd><Switch ariaLabel={labels.active} hint={labels.activeImmediately} checked={active} pending={activePending} onChange={(next) => { void toggleActive(next); }} layout="inline" /></dd></div>
    <div><dt>{labels.aliases}</dt><dd className="mono">{props.aliases.length === 0 ? labels.noAliases : props.aliases.map((alias) => `!${alias}`).join(", ")}</dd></div>
    <div><dt>{labels.kind}</dt><dd>{props.kind}</dd></div>
    <div><dt>{labels.response}</dt><dd>{draft.kind === "text" ? <TemplateText value={props.text} variables={labelsForVariables} /> : <TemplateText value={listPreview} variables={[]} />}</dd></div>
    <div><dt>{labels.responseType}</dt><dd>{props.responseType}</dd></div>
    <div><dt>{labels.minimumTier}</dt><dd>{props.minimumTier} · {props.minimumDescription}</dd></div>
    <div><dt>{labels.streamCondition}</dt><dd>{props.stream}</dd></div>
    <div><dt>{labels.cooldown}</dt><dd className="mono">{props.cooldown}</dd></div>
    <div><dt>{labels.userCooldown}</dt><dd className="mono">{props.userCooldown}</dd></div>
    {command === null ? null : <>
      <div><dt>{labels.lastUsed}</dt><dd className="mono">{relativeTime(command.lastUsedAt, labels)}</dd></div>
      <div><dt>{labels.createdAt}</dt><dd>{formatDate(command.createdAt, resolvedLanguage)}</dd></div>
      <div><dt>{labels.updatedAt}</dt><dd>{formatDate(command.updatedAt, resolvedLanguage)}</dd></div>
    </>}
  </dl>;

  const deleteButton = command === null ? undefined : <Button icon="remove" danger="subtle" onClick={() => { setConfirmingDelete(true); }}>{labels.delete}</Button>;
  return <>
    <EditorShell
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
      onDiscard={() => { reset(); setAttemptedSave(false); setSaved(false); setFieldError(null); setError(undefined); setServerWarnings([]); setTemplateIssues({ unknown: [], worstCaseExceeded: false }); }}
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
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useInspectorSelection<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusyName, setToggleBusyName] = useState<string | null>(null);
  const [minimumBusyName, setMinimumBusyName] = useState<string | null>(null);
  const guardRef = useRef<((proceed: () => void) => void) | null>(null);
  const guardSwitch = useCallback((proceed: () => void): void => {
    const guard = guardRef.current;
    if (guard === null) proceed();
    else guard(proceed);
  }, []);
  const registerGuard = useCallback((next: ((proceed: () => void) => void) | null): void => { guardRef.current = next; }, []);
  const initialSelectionApplied = useRef(false);

  const refresh = useCallback(async (selectAfter?: string): Promise<TextCommand[]> => {
    const data = await loadTextCommands(channelId);
    setCommands(data);
    setError(null);
    if (selectAfter !== undefined && data.some((item) => item.name === selectAfter)) {
      setCreateOpen(false);
      selectName(selectAfter);
    }
    return data;
  }, [channelId, selectName]);

  useEffect(() => {
    let active = true;
    void loadTextCommands(channelId).then((data) => {
      if (!active) return;
      setCommands(data); setLoading(false);
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
    try { await toggleTextCommand(channelId, command.name, !command.enabled); await refresh(); }
    catch { setError(labels.saveError); }
    finally { setToggleBusyName(null); }
  };
  const changeMinimum = async (command: TextCommand, minimumTier: TextCommandMinimumTier): Promise<void> => {
    setMinimumBusyName(command.name); setError(null);
    try { await setTextCommandMinimumTier(channelId, command.name, minimumTier); await refresh(); }
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
      <th scope="col">{labels.columns.name}</th><th scope="col">{labels.columns.response}</th><th scope="col">{labels.columns.minimumTier}</th><th scope="col">{labels.columns.active}</th>
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
