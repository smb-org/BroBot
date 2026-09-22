import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { dashboardCommonTexts, type DashboardLanguage } from "../../../dashboard/locale";
import { TEXT_COMMAND_MINIMUM_TIERS, type TextCommand, type TextCommandMinimumTier } from "../contracts";
import { deleteTextCommand, loadTextCommands, createTextCommand, toggleTextCommand, setTextCommandMinimumTier, saveTextCommand } from "./service";
import { textCommandsTexts } from "./locale";

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

interface TextCommandsSelection {
  selectedKey: string | null;
  select: (key: string) => void;
  rowRef: (key: string) => (row: HTMLTableRowElement | null) => void;
  close: () => void;
}

interface TextCommandsSubInspectorProperties {
  ariaLabel: string;
  title: ReactNode;
  identifier?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

const TextCommandsSubInspector = ({ ariaLabel, title, identifier, onClose, children }: TextCommandsSubInspectorProperties): ReactElement => (
  <section className="command-inspector sub-inspector config-section" aria-label={ariaLabel} onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="inspector-section__heading">
      <h3>{title}</h3>
      {identifier === undefined ? null : <span className="mono muted">{identifier}</span>}
      <button className="button button--quiet inspector-close" type="button" aria-label={dashboardCommonTexts().schliessen} onClick={onClose}>
        <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
    {children}
  </section>
);

const useTextCommandsSelection = (): TextCommandsSelection => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const select = useCallback((key: string): void => {
    selectedKeyRef.current = key;
    setSelectedKey(key);
  }, []);

  const rowRef = useCallback((key: string) => (row: HTMLTableRowElement | null): void => {
    if (row === null) {
      rowRefs.current.delete(key);
    } else {
      rowRefs.current.set(key, row);
    }
  }, []);

  const close = useCallback((): void => {
    const key = selectedKeyRef.current;
    selectedKeyRef.current = null;
    setSelectedKey(null);
    if (key !== null) rowRefs.current.get(key)?.focus();
  }, []);

  return { selectedKey, select, rowRef, close };
};

const TextCommandEditor = ({ channelId, language, initial, onChanged, canManageContent, onClose }: TextCommandEditorProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [art, setArt] = useState(initial.kind);
  const [cooldownSeconds, setCooldownSekunden] = useState<number | "">(initial.cooldownSeconds);
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
        kind: art,
        ...(art === "text" ? { text } : {}),
        cooldownSeconds,
      });
      await onChanged();
    } catch {
      setError(labels.speichernFehler);
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
      setError(labels.loeschenFehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TextCommandsSubInspector ariaLabel={labels.details(initial.name)} title={`!${initial.name}`} identifier={<span className="command-inspector__meta">{labels.spalten.zuletzt} {relativeZeit(initial.lastUsedAt, labels)}</span>} onClose={onClose}>
      {!canManageContent ? <p className="sperrgrund">{labels.verwaltungGesperrt}</p> : null}
      <label className="config-field config-field--mittel">
        {labels.name}
        <input value={name} onChange={(event) => { setName(event.target.value); }} disabled={!canManageContent || busy} pattern="[a-z0-9][a-z0-9_-]{0,31}" />
      </label>
      <label className="config-field config-field--schmal">
        {labels.kind}
        <select aria-label={labels.kind} value={art} onChange={(event) => { setArt(event.target.value as "text" | "list"); }} disabled={!canManageContent || busy}>
          <option value="text">{labels.artText}</option>
          <option value="list">{labels.artListe}</option>
        </select>
      </label>
      {art === "text" ? <label className="config-field config-field--breit">
        {labels.text}
        <textarea value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent || busy} />
      </label> : null}
      <label className="config-field config-field--schmal">
        {labels.abkuehlung}
        <input type="number" min="0" max="86400" value={cooldownSeconds} aria-invalid={cooldownError} onChange={(event) => { setCooldownError(false); setCooldownSekunden(event.target.value === "" ? "" : Number(event.target.value)); }} disabled={!canManageContent || busy} />
        {cooldownError ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
      </label>
      <div className="form-actions">
        <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={!canManageContent || busy}>{labels.speichern(initial.name)}</button>
      </div>
      <div className="form-actions form-actions--destructive">
        <button className="button button--danger" type="button" onClick={() => { setError(null); setConfirmingDelete(true); }} disabled={!canManageContent || busy}>{labels.loeschen(initial.name)}</button>
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
          <h3 id="text-command-delete-confirmation-title">{labels.loeschenTitel(initial.name)}</h3>
          <p id="text-command-delete-confirmation-description">{labels.loeschenBestaetigung(initial.name)}</p>
          <div className="form-actions">
            <button ref={confirmButtonRef} className="button button--danger" type="button" onClick={() => { void remove(); }} disabled={!canManageContent || busy}>{labels.loeschungBestaetigen(initial.name)}</button>
            <button ref={cancelButtonRef} className="button button--quiet" type="button" onClick={() => { setConfirmingDelete(false); }} disabled={busy}>{dashboardCommonTexts().abbrechen}</button>
          </div>
        </div>
      ) : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </TextCommandsSubInspector>
  );
};

const relativeZeit = (value: string | null, labels: ReturnType<typeof textCommandsTexts>): string => {
  if (value === null) return labels.nie;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return labels.nie;
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return labels.vorSekunden(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return labels.vorMinuten(minutes);
  return labels.vorStunden(Math.round(minutes / 60));
};

const commandRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
};

const TextCommandRow = ({ initial, language, selected, onSelect, rowRef, canManageContent, toggleBusy, onToggle, minimumBusy, onMinimumChange }: TextCommandRowProperties): ReactElement => {
  const labels = textCommandsTexts(language);
  const minimumDisabledReason = canManageContent ? undefined : labels.minimumTierGesperrt;
  const minimumTier = (initial as { minimumTier?: TextCommandMinimumTier }).minimumTier ?? "everyone";
  return (
    <tr ref={rowRef} tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td>{initial.kind === "text" ? labels.artText : labels.artListe}</td>
      <td className="tabelle__answer" title={initial.kind === "text" ? initial.text : undefined}>{initial.kind === "text" ? initial.text : "—"}</td>
      <td className="mono">{initial.cooldownSeconds}</td>
      <td className="tabelle__last-used">{relativeZeit(initial.lastUsedAt, labels)}</td>
      <td>
        <select
          aria-label={labels.minimumTierFuer(initial.name)}
          value={minimumTier}
          disabled={!canManageContent || minimumBusy}
          aria-busy={minimumBusy}
          title={minimumDisabledReason}
          onClick={(event) => { event.stopPropagation(); }}
          onChange={(event) => { void onMinimumChange(event.target.value as TextCommandMinimumTier); }}
        >
          {TEXT_COMMAND_MINIMUM_TIERS.map((tier) => <option key={tier} value={tier}>{labels.stufen[tier]}</option>)}
        </select>
      </td>
      <td>
        <button
          className="switch"
          type="button"
          role="switch"
          aria-label={labels.schalter(initial.name, initial.enabled)}
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

export const TextCommandsPanel = ({ channelId, language, canManage: canManageContent = true, onCloseInspector }: { channelId: string; language?: DashboardLanguage; canManage?: boolean; onCloseInspector?: () => void }): ReactElement => {
  const labels = textCommandsTexts(language);
  const [commands, setCommands] = useState<TextCommand[]>([]);
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useTextCommandsSelection();
  const [anlegenOffen, setAnlegenOffen] = useState(false);
  const anlegenButton = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [art, setArt] = useState<"text" | "list">("text");
  const [cooldownSeconds, setCooldownSekunden] = useState<number | "">(5);
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
      setError(labels.fehler);
    } finally {
      setLoading(false);
    }
  }, [channelId, closeSelection, labels.fehler, selectedName]);

  useEffect(() => {
    let active = true;
    void loadTextCommands(channelId).then((data) => {
      if (!active) return;
      setCommands(data);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(labels.fehler);
      setLoading(false);
    });
    return () => { active = false; };
  }, [channelId, labels.fehler]);

  const selected = useMemo(() => commands.find((command) => command.name === selectedName) ?? null, [commands, selectedName]);
  const closeInspector = useCallback((): void => {
    closeSelection();
    onCloseInspector?.();
  }, [closeSelection, onCloseInspector]);
  const openCreate = (): void => {
    closeSelection();
    setAnlegenOffen(true);
    anlegenButton.current?.focus();
  };
  const closeCreate = (): void => {
    setAnlegenOffen(false);
    anlegenButton.current?.focus();
  };
  const nameValid = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim());
  const canCreate = nameValid && (art === "list" || text.trim().length > 0);

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
      await createTextCommand(channelId, { name: name.trim(), kind: art, ...(art === "text" ? { text } : {}), cooldownSeconds });
      setName("");
      setText("");
      setArt("text");
      setCooldownSekunden(5);
      await load();
    } catch {
      setError(labels.speichernFehler);
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
      setError(labels.speichernFehler);
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
      setError(labels.speichernFehler);
    } finally {
      setMinimumBusyName(null);
    }
  };

  return (
    <section className="module-stack command-panel" aria-label={labels.titel}>
      <section className={`inspektor-bereich${selected === null && !anlegenOffen ? "" : " inspektor-bereich--offen"}`}>
        <div className="inspektor-bereich__liste">
          <section className="command-list config-section" aria-label={labels.liste}>
            <div className="section-heading">
              <h2>{labels.liste}</h2>
              <button ref={anlegenButton} className="button button--quiet inspector-close" type="button" aria-label={labels.anlegen} onClick={openCreate}>
                <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            {loading ? <p className="loading-line">{labels.laden}</p> : null}
            {error === null ? null : <p className="form-error" role="alert">{error}</p>}
            {!loading && error === null && commands.length === 0 ? <p className="empty-state">{labels.leer}</p> : null}
            {!loading && error === null && commands.length > 0 ? <div className="tabelle-wrap"><table className="tabelle"><thead><tr><th scope="col">{labels.spalten.name}</th><th scope="col">{labels.spalten.kind}</th><th scope="col">{labels.spalten.text}</th><th scope="col">{labels.spalten.abkuehlung}</th><th scope="col">{labels.spalten.zuletzt}</th><th scope="col">{labels.spalten.minimumTier}</th><th scope="col">{labels.spalten.aktiv}</th></tr></thead><tbody>{commands.map((command) => <TextCommandRow key={command.name} channelId={channelId} language={language} initial={command} selected={selectedName === command.name} onSelect={() => { setAnlegenOffen(false); selectName(command.name); }} rowRef={rowRef(command.name)} onChanged={load} canManageContent={canManageContent} toggleBusy={toggleBusyName === command.name} onToggle={() => toggle(command)} minimumBusy={minimumBusyName === command.name} onMinimumChange={(minimumTier) => changeMinimum(command, minimumTier)} />)}</tbody></table></div> : null}
          </section>
        </div>
        {selected !== null ? <TextCommandEditor key={selected.name} channelId={channelId} language={language} initial={selected} onChanged={load} canManageContent={canManageContent} onClose={closeInspector} /> : anlegenOffen ? (
          <TextCommandsSubInspector ariaLabel={labels.anlegen} title={labels.anlegen} onClose={closeCreate}>
            <form className="config-section" aria-busy={creating} onSubmit={(event) => { event.preventDefault(); void create(); }}>
              <fieldset disabled={!canManageContent || creating}>
              {!canManageContent ? <p className="sperrgrund">{labels.verwaltungGesperrt}</p> : null}
              <label className="config-field config-field--mittel">
                {labels.name}
                <input aria-label={labels.name} value={name} onChange={(event) => { setName(event.target.value); }} pattern="[a-z0-9][a-z0-9_-]{0,31}" disabled={!canManageContent} />
                <span className="muted">{labels.nameHinweis}</span>
              </label>
              <label className="config-field config-field--schmal">
                {labels.kind}
                <select aria-label={labels.kind} value={art} onChange={(event) => { setArt(event.target.value as "text" | "list"); }} disabled={!canManageContent}>
                  <option value="text">{labels.artText}</option>
                  <option value="list">{labels.artListe}</option>
                </select>
              </label>
              {art === "text" ? <label className="config-field config-field--breit">
                {labels.text}
                <textarea aria-label={labels.text} value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent} />
              </label> : null}
              <label className="config-field config-field--schmal">
                {labels.abkuehlung}
                <input type="number" min="0" max="86400" value={cooldownSeconds} aria-invalid={cooldownError} onChange={(event) => { setCooldownError(false); setCooldownSekunden(event.target.value === "" ? "" : Number(event.target.value)); }} />
                {cooldownError ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
              </label>
              <div className="form-actions form-actions--create"><button className={canCreate ? "button button--primary" : "button"} type="submit" disabled={!canCreate}>{labels.anlegen}</button>{canCreate ? null : <span className="form-hint">{nameValid ? (art === "text" ? labels.antwortFehlt : labels.nameFehlt) : (art === "text" ? labels.nameAntwortFehlt : labels.nameFehlt)}</span>}</div>
              </fieldset>
            </form>
          </TextCommandsSubInspector>
        ) : null}
      </section>
    </section>
  );
};

export default TextCommandsPanel;
