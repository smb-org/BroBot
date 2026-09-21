import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

import { dashboardGemeinsameTexte, type DashboardLanguage } from "../../../dashboard/locale";
import { TEXTBEFEHL_MINDESTSTUFEN, type Textbefehl, type TextbefehlMindeststufe } from "../contracts";
import { loescheTextbefehl, ladeTextbefehle, legeTextbefehlAn, schalteTextbefehl, setzeTextbefehlMindeststufe, speichereTextbefehl } from "./service";
import { textbefehleTexte } from "./locale";

interface TextbefehlZeileProperties {
  channelId: string;
  language?: DashboardLanguage | undefined;
  initial: Textbefehl;
  onChanged: () => Promise<void>;
  selected: boolean;
  onSelect: () => void;
  rowRef: (row: HTMLTableRowElement | null) => void;
  canManageContent: boolean;
  toggleBusy: boolean;
  onToggle: () => Promise<void>;
  minimumBusy: boolean;
  onMinimumChange: (mindeststufe: TextbefehlMindeststufe) => Promise<void>;
}

type TextbefehlEditorProperties = Pick<TextbefehlZeileProperties, "channelId" | "language" | "initial" | "onChanged" | "canManageContent"> & { onClose: () => void };

interface TextbefehleSelection {
  selectedKey: string | null;
  select: (key: string) => void;
  rowRef: (key: string) => (row: HTMLTableRowElement | null) => void;
  close: () => void;
}

interface TextbefehleSubInspectorProperties {
  ariaLabel: string;
  title: ReactNode;
  identifier?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

const TextbefehleSubInspector = ({ ariaLabel, title, identifier, onClose, children }: TextbefehleSubInspectorProperties): ReactElement => (
  <section className="command-inspector sub-inspector config-section" aria-label={ariaLabel} onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="inspector-section__heading">
      <h3>{title}</h3>
      {identifier === undefined ? null : <span className="mono muted">{identifier}</span>}
      <button className="button button--quiet inspector-close" type="button" aria-label={dashboardGemeinsameTexte().schliessen} onClick={onClose}>
        <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
    {children}
  </section>
);

const useTextbefehleSelection = (): TextbefehleSelection => {
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

const TextbefehlEditor = ({ channelId, language, initial, onChanged, canManageContent, onClose }: TextbefehlEditorProperties): ReactElement => {
  const labels = textbefehleTexte(language);
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState(initial.text);
  const [art, setArt] = useState(initial.art);
  const [cooldownSekunden, setCooldownSekunden] = useState(initial.cooldownSekunden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmingDelete) confirmButtonRef.current?.focus();
  }, [confirmingDelete]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await speichereTextbefehl(channelId, {
        oldName: initial.name,
        name: name.trim(),
        art,
        ...(art === "text" ? { text } : {}),
        cooldownSekunden,
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
      await loescheTextbefehl(channelId, initial.name);
      setConfirmingDelete(false);
      await onChanged();
    } catch {
      setError(labels.loeschenFehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <TextbefehleSubInspector ariaLabel={labels.details(initial.name)} title={`!${initial.name}`} identifier={<span className="command-inspector__meta">{labels.spalten.zuletzt} {relativeZeit(initial.zuletztVerwendetAt, labels)}</span>} onClose={onClose}>
      {!canManageContent ? <p className="sperrgrund">{labels.verwaltungGesperrt}</p> : null}
      <label className="config-field config-field--mittel">
        {labels.name}
        <input value={name} onChange={(event) => { setName(event.target.value); }} disabled={!canManageContent || busy} pattern="[a-z0-9][a-z0-9_-]{0,31}" />
      </label>
      <label className="config-field config-field--schmal">
        {labels.art}
        <select aria-label={labels.art} value={art} onChange={(event) => { setArt(event.target.value as "text" | "liste"); }} disabled={!canManageContent || busy}>
          <option value="text">{labels.artText}</option>
          <option value="liste">{labels.artListe}</option>
        </select>
      </label>
      {art === "text" ? <label className="config-field config-field--breit">
        {labels.text}
        <textarea value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent || busy} />
      </label> : null}
      <label className="config-field config-field--schmal">
        {labels.abkuehlung}
        <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} disabled={!canManageContent || busy} />
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
            <button className="button button--quiet" type="button" onClick={() => { setConfirmingDelete(false); }} disabled={busy}>{dashboardGemeinsameTexte().abbrechen}</button>
          </div>
        </div>
      ) : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </TextbefehleSubInspector>
  );
};

const relativeZeit = (value: string | null, labels: ReturnType<typeof textbefehleTexte>): string => {
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

const TextbefehlZeile = ({ initial, language, selected, onSelect, rowRef, canManageContent, toggleBusy, onToggle, minimumBusy, onMinimumChange }: TextbefehlZeileProperties): ReactElement => {
  const labels = textbefehleTexte(language);
  const minimumDisabledReason = canManageContent ? undefined : labels.mindeststufeGesperrt;
  const mindeststufe = (initial as { mindeststufe?: TextbefehlMindeststufe }).mindeststufe ?? "alle";
  return (
    <tr ref={rowRef} tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td>{initial.art === "text" ? labels.artText : labels.artListe}</td>
      <td className="tabelle__answer" title={initial.art === "text" ? initial.text : undefined}>{initial.art === "text" ? initial.text : "—"}</td>
      <td className="mono">{initial.cooldownSekunden}</td>
      <td className="tabelle__last-used">{relativeZeit(initial.zuletztVerwendetAt, labels)}</td>
      <td>
        <select
          aria-label={labels.mindeststufeFuer(initial.name)}
          value={mindeststufe}
          disabled={!canManageContent || minimumBusy}
          aria-busy={minimumBusy}
          title={minimumDisabledReason}
          onClick={(event) => { event.stopPropagation(); }}
          onChange={(event) => { void onMinimumChange(event.target.value as TextbefehlMindeststufe); }}
        >
          {TEXTBEFEHL_MINDESTSTUFEN.map((stufe) => <option key={stufe} value={stufe}>{labels.stufen[stufe]}</option>)}
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

export const TextbefehlePanel = ({ channelId, language, canManage: canManageContent = true, onCloseInspector }: { channelId: string; language?: DashboardLanguage; canManage?: boolean; onCloseInspector?: () => void }): ReactElement => {
  const labels = textbefehleTexte(language);
  const [befehle, setBefehle] = useState<Textbefehl[]>([]);
  const { selectedKey: selectedName, select: selectName, rowRef, close: closeSelection } = useTextbefehleSelection();
  const [anlegenOffen, setAnlegenOffen] = useState(false);
  const anlegenButton = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [art, setArt] = useState<"text" | "liste">("text");
  const [cooldownSekunden, setCooldownSekunden] = useState(5);
  const [toggleBusyName, setToggleBusyName] = useState<string | null>(null);
  const [minimumBusyName, setMinimumBusyName] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await ladeTextbefehle(channelId);
      setBefehle(data);
      if (selectedName !== null && !data.some((befehl) => befehl.name === selectedName)) closeSelection();
    } catch {
      setError(labels.fehler);
    } finally {
      setLoading(false);
    }
  }, [channelId, closeSelection, labels.fehler, selectedName]);

  useEffect(() => {
    let active = true;
    void ladeTextbefehle(channelId).then((data) => {
      if (!active) return;
      setBefehle(data);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(labels.fehler);
      setLoading(false);
    });
    return () => { active = false; };
  }, [channelId, labels.fehler]);

  const selected = useMemo(() => befehle.find((befehl) => befehl.name === selectedName) ?? null, [befehle, selectedName]);
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
  const canCreate = nameValid && (art === "liste" || text.trim().length > 0);

  const create = async (): Promise<void> => {
    if (!canManageContent || !canCreate) return;
    setError(null);
    try {
      await legeTextbefehlAn(channelId, { name: name.trim(), art, ...(art === "text" ? { text } : {}), cooldownSekunden });
      setName("");
      setText("");
      setArt("text");
      setCooldownSekunden(5);
      await load();
    } catch {
      setError(labels.speichernFehler);
    }
  };

  const toggle = async (befehl: Textbefehl): Promise<void> => {
    setToggleBusyName(befehl.name);
    setError(null);
    try {
      await schalteTextbefehl(channelId, befehl.name, !befehl.enabled);
      await load();
    } catch {
      setError(labels.speichernFehler);
    } finally {
      setToggleBusyName(null);
    }
  };

  const changeMinimum = async (befehl: Textbefehl, mindeststufe: TextbefehlMindeststufe): Promise<void> => {
    setMinimumBusyName(befehl.name);
    setError(null);
    try {
      await setzeTextbefehlMindeststufe(channelId, befehl.name, mindeststufe);
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
            {!loading && error === null && befehle.length === 0 ? <p className="empty-state">{labels.leer}</p> : null}
            {!loading && error === null && befehle.length > 0 ? <div className="tabelle-wrap"><table className="tabelle"><thead><tr><th scope="col">{labels.spalten.name}</th><th scope="col">{labels.spalten.art}</th><th scope="col">{labels.spalten.text}</th><th scope="col">{labels.spalten.abkuehlung}</th><th scope="col">{labels.spalten.zuletzt}</th><th scope="col">{labels.spalten.mindeststufe}</th><th scope="col">{labels.spalten.aktiv}</th></tr></thead><tbody>{befehle.map((befehl) => <TextbefehlZeile key={befehl.name} channelId={channelId} language={language} initial={befehl} selected={selectedName === befehl.name} onSelect={() => { setAnlegenOffen(false); selectName(befehl.name); }} rowRef={rowRef(befehl.name)} onChanged={load} canManageContent={canManageContent} toggleBusy={toggleBusyName === befehl.name} onToggle={() => toggle(befehl)} minimumBusy={minimumBusyName === befehl.name} onMinimumChange={(mindeststufe) => changeMinimum(befehl, mindeststufe)} />)}</tbody></table></div> : null}
          </section>
        </div>
        {selected !== null ? <TextbefehlEditor channelId={channelId} language={language} initial={selected} onChanged={load} canManageContent={canManageContent} onClose={closeInspector} /> : anlegenOffen ? (
          <TextbefehleSubInspector ariaLabel={labels.anlegen} title={labels.anlegen} onClose={closeCreate}>
            <form className="config-section" onSubmit={(event) => { event.preventDefault(); void create(); }}>
              {!canManageContent ? <p className="sperrgrund">{labels.verwaltungGesperrt}</p> : null}
              <label className="config-field config-field--mittel">
                {labels.name}
                <input aria-label={labels.name} value={name} onChange={(event) => { setName(event.target.value); }} pattern="[a-z0-9][a-z0-9_-]{0,31}" disabled={!canManageContent} />
                <span className="muted">{labels.nameHinweis}</span>
              </label>
              <label className="config-field config-field--schmal">
                {labels.art}
                <select aria-label={labels.art} value={art} onChange={(event) => { setArt(event.target.value as "text" | "liste"); }} disabled={!canManageContent}>
                  <option value="text">{labels.artText}</option>
                  <option value="liste">{labels.artListe}</option>
                </select>
              </label>
              {art === "text" ? <label className="config-field config-field--breit">
                {labels.text}
                <textarea aria-label={labels.text} value={text} onChange={(event) => { setText(event.target.value); }} disabled={!canManageContent} />
              </label> : null}
              <label className="config-field config-field--schmal">
                {labels.abkuehlung}
                <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} disabled={!canManageContent} />
              </label>
              <div className="form-actions form-actions--create"><button className={canCreate ? "button button--primary" : "button"} type="submit" disabled={!canManageContent || !canCreate}>{labels.anlegen}</button>{canCreate ? null : <span className="form-hint">{nameValid ? (art === "text" ? labels.antwortFehlt : labels.nameFehlt) : (art === "text" ? labels.nameAntwortFehlt : labels.nameFehlt)}</span>}</div>
            </form>
          </TextbefehleSubInspector>
        ) : null}
      </section>
    </section>
  );
};

export default TextbefehlePanel;
