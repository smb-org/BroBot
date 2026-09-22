import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { dashboardCommonTexts, type DashboardLanguage } from "../../../dashboard/locale";
import { ListDetail, SubInspector, useInspectorSelection } from "../../../dashboard/ui";
import { TEXT_COMMAND_MINIMUM_TIERS, type TextCommand, type TextCommandMinimumTier } from "../contracts";
import { validCommandName } from "../domain";
import { deleteTextCommand, loadTextCommands, createTextCommand, toggleTextCommand, setTextCommandMinimumTier, saveTextCommand } from "./service";
import { textCommandsTexts } from "./locale";

const normalizeCommandName = (name: string): string => name.trim().replace(/^!/u, "").toLowerCase();

interface TextCommandRowProperties {
  channelId: string;
  language?: DashboardLanguage | undefined;
  initial: TextCommand;
  onChanged: () => Promise<void>;
  selected: boolean;
  onSelect: () => void;
  rowRef: (row: HTMLTableRowElement | null) => void;
  canManageContent: boolean;
  toggleBusy: boolean;
  onToggle: () => Promise<void>;
  minimumBusy: boolean;
  onMinimumChange: (minimumTier: TextCommandMinimumTier) => Promise<void>;
}

type TextCommandEditorProperties = Pick<TextCommandRowProperties, "channelId" | "language" | "initial" | "onChanged" | "canManageContent"> & { onClose: () => void };

const TextCommandEditor = ({ channelId, language, initial, onChanged, canManageContent, onClose }: TextCommandEditorProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [kind, setKind] = useState(initial.kind);
  const [cooldownSeconds, setCooldownSeconds] = useState<number | "">(initial.cooldownSeconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldownError, setCooldownError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmingDelete) cancelButtonRef.current?.focus();
  }, [confirmingDelete]);

  const save = async (): Promise<void> => {
    if (cooldownSeconds === "") {
      setCooldownError(true);
      return;
    }
    setCooldownError(false);
    setBusy(true);
    setError(null);
    try {
      await saveTextCommand(channelId, {
        oldName: initial.name,
        name: name.trim(),
        kind,
        ...(kind === "text" ? { text } : {}),
        cooldownSeconds,
      });
      await onChanged();
    } catch {
      setError(labels.saveError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await deleteTextCommand(channelId, initial.name);
      setConfirmingDelete(false);
      await onChanged();
    } catch {
      setError(labels.deleteError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SubInspector ariaLabel={labels.details(initial.name)} title={`!${initial.name}`} identifier={initial.name} meta={<span className="command-inspector__meta">{labels.columns.last} {relativeTime(initial.lastUsedAt, labels)}</span>} className="config-section" closeLabel={dashboardCommonTexts().close} onClose={onClose}>
      {!canManageContent ? <p className="lock-reason">{labels.managementLocked}</p> : null}
      <label className="config-field config-field--medium">
        {labels.name}
        <input value={name} onChange={(event) => { setName(event.target.value); }} disabled={!canManageContent || busy} pattern="[a-z0-9][a-z0-9_-]{0,31}" />
      </label>
      <label className="config-field config-field--narrow">
        {labels.kind}
        <select aria-label={labels.kind} value={kind} onChange={(event) => { setKind(event.target.value as "text" | "list"); }} disabled={!canManageContent || busy}>
          <option value="text">{labels.kindText}</option>
          <option value="list">{labels.kindList}</option>
        </select>
      </label>
      {kind === "text" ? <label className="config-field config-field--wide">
        {labels.text}
        <textarea value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent || busy} />
      </label> : null}
      <label className="config-field config-field--narrow">
        {labels.cooldown}
        <input type="number" min="0" max="86400" value={cooldownSeconds} aria-invalid={cooldownError} onChange={(event) => { setCooldownError(false); setCooldownSeconds(event.target.value === "" ? "" : Number(event.target.value)); }} disabled={!canManageContent || busy} />
        {cooldownError ? <span className="form-error" role="alert">{labels.numberMissing}</span> : null}
      </label>
      <div className="form-actions">
        <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={!canManageContent || busy}>{labels.save(initial.name)}</button>
      </div>
      <div className="form-actions form-actions--destructive">
        <button className="button button--danger" type="button" onClick={() => { setError(null); setConfirmingDelete(true); }} disabled={!canManageContent || busy}>{labels.delete(initial.name)}</button>
      </div>
      {confirmingDelete ? (
        <div
          className="inspector-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="text-command-delete-confirmation-title"
          aria-describedby="text-command-delete-confirmation-description"
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setConfirmingDelete(false); } }}
        >
          <h3 id="text-command-delete-confirmation-title">{labels.deleteTitle(initial.name)}</h3>
          <p id="text-command-delete-confirmation-description">{labels.deleteConfirmation(initial.name)}</p>
          <div className="form-actions">
            <button ref={confirmButtonRef} className="button button--danger" type="button" onClick={() => { void remove(); }} disabled={!canManageContent || busy}>{labels.confirmDeletion(initial.name)}</button>
            <button ref={cancelButtonRef} className="button button--quiet" type="button" onClick={() => { setConfirmingDelete(false); }} disabled={busy}>{dashboardCommonTexts().cancel}</button>
          </div>
        </div>
      ) : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </SubInspector>
  );
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

const commandRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
};

/**
 * Four columns -- name, response, minimum level, toggle. Kind is readable
 * from the response itself (a "list" command shows "—", same as before);
 * cooldown and "last used" moved into the inspector (`TextCommandEditor`'s
 * cooldown field, and the identifier line above) rather than staying
 * visible in the list -- an accepted cost, not a gap. See "The
 * text-commands table loses two columns" in the epic's task description.
 */
const TextCommandRow = ({ initial, language, selected, onSelect, rowRef, canManageContent, toggleBusy, onToggle, minimumBusy, onMinimumChange }: TextCommandRowProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  const minimumDisabledReason = canManageContent ? undefined : labels.minimumTierLocked;
  const minimumTier = (initial as { minimumTier?: TextCommandMinimumTier }).minimumTier ?? "everyone";
  return (
    <tr ref={rowRef} tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td className="table__answer" title={initial.kind === "text" ? initial.text : undefined}>{initial.kind === "text" ? initial.text : "—"}</td>
      <td>
        <select
          aria-label={labels.minimumTierFor(initial.name)}
          value={minimumTier}
          disabled={!canManageContent || minimumBusy}
          aria-busy={minimumBusy}
          title={minimumDisabledReason}
          onClick={(event) => { event.stopPropagation(); }}
          onChange={(event) => { void onMinimumChange(event.target.value as TextCommandMinimumTier); }}
        >
          {TEXT_COMMAND_MINIMUM_TIERS.map((tier) => <option key={tier} value={tier}>{labels.tiers[tier]}</option>)}
        </select>
      </td>
      <td>
        <button
          className="switch"
          type="button"
          role="switch"
          aria-label={labels.toggleLabel(initial.name, initial.enabled)}
          aria-checked={initial.enabled}
          aria-busy={toggleBusy}
          disabled={toggleBusy}
          onClick={(event) => { event.stopPropagation(); void onToggle(); }}
        >
          <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
        </button>
      </td>
    </tr>
  );
};

export const TextCommandsPanel = ({ channelId, language, canManage: canManageContent = true, onCloseInspector, initialSelection }: { channelId: string; language?: DashboardLanguage; canManage?: boolean; onCloseInspector?: () => void; initialSelection?: string }): ReactElement => {
  const labels = textCommandsTexts(language);
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useInspectorSelection<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"text" | "list">("text");
  const [cooldownSeconds, setCooldownSeconds] = useState<number | "">(5);
  const [cooldownError, setCooldownError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toggleBusyName, setToggleBusyName] = useState<string | null>(null);
  const [minimumBusyName, setMinimumBusyName] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await loadTextCommands(channelId);
      setCommands(data);
      if (selectedName !== null && !data.some((command) => command.name === selectedName)) closeSelection();
    } catch {
      setError(labels.error);
    } finally {
      setLoading(false);
    }
  }, [channelId, closeSelection, labels.error, selectedName]);

  useEffect(() => {
    let active = true;
    void loadTextCommands(channelId).then((data) => {
      if (!active) return;
      setCommands(data);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(labels.error);
      setLoading(false);
    });
    return () => { active = false; };
  }, [channelId, labels.error]);

  // Spotlight deep link (#164): select the command it named, once it's loaded.
  useEffect(() => {
    if (initialSelection === undefined) return;
    if (commands.some((command) => command.name === initialSelection)) selectName(initialSelection);
  }, [commands, initialSelection, selectName]);

  const selected = useMemo(() => commands.find((command) => command.name === selectedName) ?? null, [commands, selectedName]);
  const closeInspector = useCallback((): void => {
    closeSelection();
    onCloseInspector?.();
  }, [closeSelection, onCloseInspector]);
  const openCreate = (): void => {
    closeSelection();
    setCreateOpen(true);
    createButton.current?.focus();
  };
  const closeCreate = (): void => {
    setCreateOpen(false);
    createButton.current?.focus();
  };
  const closeFloating = useCallback((): void => {
    if (selected !== null) { closeInspector(); return; }
    if (createOpen) closeCreate();
  }, [selected, closeInspector, createOpen]);
  const normalizedName = normalizeCommandName(name);
  const nameEmpty = normalizedName.length === 0;
  const nameValid = validCommandName(normalizedName);
  const responseMissing = kind === "text" && text.trim().length === 0;
  const canCreate = nameValid && !responseMissing;
  const createHint = nameEmpty ? labels.nameMissing : !nameValid ? labels.nameInvalid : responseMissing ? labels.responseMissing : null;

  const create = async (): Promise<void> => {
    if (!canManageContent || !canCreate || creating) return;
    if (cooldownSeconds === "") {
      setCooldownError(true);
      return;
    }
    setCooldownError(false);
    setError(null);
    setCreating(true);
    try {
      await createTextCommand(channelId, { name: normalizedName, kind, ...(kind === "text" ? { text } : {}), cooldownSeconds });
      setName("");
      setText("");
      setKind("text");
      setCooldownSeconds(5);
      await load();
    } catch {
      setError(labels.saveError);
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (command: TextCommand): Promise<void> => {
    setToggleBusyName(command.name);
    setError(null);
    try {
      await toggleTextCommand(channelId, command.name, !command.enabled);
      await load();
    } catch {
      setError(labels.saveError);
    } finally {
      setToggleBusyName(null);
    }
  };

  const changeMinimum = async (command: TextCommand, minimumTier: TextCommandMinimumTier): Promise<void> => {
    setMinimumBusyName(command.name);
    setError(null);
    try {
      await setTextCommandMinimumTier(channelId, command.name, minimumTier);
      await load();
    } catch {
      setError(labels.saveError);
    } finally {
      setMinimumBusyName(null);
    }
  };

  const list = (
    <section className="command-list config-section" aria-label={labels.list}>
      <div className="section-heading">
        <h2>{labels.list}</h2>
        <button ref={createButton} className="button button--quiet inspector-close" type="button" aria-label={labels.add} onClick={openCreate}>
          <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      {loading ? <p className="loading-line">{labels.load}</p> : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      {!loading && error === null && commands.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
      {!loading && error === null && commands.length > 0 ? <div className="table-wrap"><table className="table"><thead><tr><th scope="col">{labels.columns.name}</th><th scope="col">{labels.columns.text}</th><th scope="col">{labels.columns.minimumTier}</th><th scope="col">{labels.columns.active}</th></tr></thead><tbody>{commands.map((command) => <TextCommandRow key={command.name} channelId={channelId} language={language} initial={command} selected={selectedName === command.name} onSelect={() => { setCreateOpen(false); selectName(command.name); }} rowRef={rowRef(command.name)} onChanged={load} canManageContent={canManageContent} toggleBusy={toggleBusyName === command.name} onToggle={() => toggle(command)} minimumBusy={minimumBusyName === command.name} onMinimumChange={(minimumTier) => changeMinimum(command, minimumTier)} />)}</tbody></table></div> : null}
    </section>
  );

  const inspector = selected !== null ? (
    <TextCommandEditor key={selected.name} channelId={channelId} language={language} initial={selected} onChanged={load} canManageContent={canManageContent} onClose={closeInspector} />
  ) : createOpen ? (
    <SubInspector ariaLabel={labels.add} title={labels.add} className="config-section" closeLabel={dashboardCommonTexts().close} onClose={closeCreate}>
      <form className="config-section" aria-busy={creating} onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <fieldset disabled={!canManageContent || creating}>
        {!canManageContent ? <p className="lock-reason">{labels.managementLocked}</p> : null}
        <label className="config-field config-field--medium">
          {labels.name}
          <input aria-label={labels.name} value={normalizedName} onChange={(event) => { setName(event.target.value); }} pattern="[a-z0-9][a-z0-9_-]{0,31}" disabled={!canManageContent} />
          <span className="muted">{labels.nameHint}</span>
        </label>
        <label className="config-field config-field--narrow">
          {labels.kind}
          <select aria-label={labels.kind} value={kind} onChange={(event) => { setKind(event.target.value as "text" | "list"); }} disabled={!canManageContent}>
            <option value="text">{labels.kindText}</option>
            <option value="list">{labels.kindList}</option>
          </select>
        </label>
        {kind === "text" ? <label className="config-field config-field--wide">
          {labels.text}
          <textarea aria-label={labels.text} value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent} />
        </label> : null}
        <label className="config-field config-field--narrow">
          {labels.cooldown}
          <input type="number" min="0" max="86400" value={cooldownSeconds} aria-invalid={cooldownError} onChange={(event) => { setCooldownError(false); setCooldownSeconds(event.target.value === "" ? "" : Number(event.target.value)); }} />
          {cooldownError ? <span className="form-error" role="alert">{labels.numberMissing}</span> : null}
        </label>
        <div className="form-actions form-actions--create"><button className={canCreate ? "button button--primary" : "button"} type="submit" disabled={!canCreate}>{labels.add}</button>{createHint === null ? null : <span className="form-hint">{createHint}</span>}</div>
        </fieldset>
      </form>
    </SubInspector>
  ) : null;

  return (
    <section className="module-stack command-panel" aria-label={labels.title}>
      <ListDetail list={list} inspector={inspector} onCloseInspector={closeFloating} />
    </section>
  );
};

export default TextCommandsPanel;
