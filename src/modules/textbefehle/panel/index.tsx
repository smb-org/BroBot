import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import type { Textbefehl } from "../contracts";
import { loescheTextbefehl, ladeTextbefehle, legeTextbefehlAn, speichereTextbefehl } from "./service";
import { textbefehleTexte } from "./locale";

interface TextbefehlZeileProperties {
  channelId: string;
  language?: DashboardLanguage | undefined;
  initial: Textbefehl;
  onChanged: () => Promise<void>;
  selected: boolean;
  onSelect: () => void;
}

const TextbefehlEditor = ({ channelId, language, initial, onChanged }: Omit<TextbefehlZeileProperties, "selected" | "onSelect">): ReactElement => {
  const labels = textbefehleTexte(language);
  const [text, setText] = useState(initial.text);
  const [cooldownSekunden, setCooldownSekunden] = useState(initial.cooldownSekunden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await speichereTextbefehl(channelId, { name: initial.name, text, cooldownSekunden });
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
      await onChanged();
    } catch {
      setError(labels.loeschenFehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="command-inspector" aria-label={labels.details(initial.name)}>
      <div className="inspector-section__heading"><h3>!{initial.name}</h3><span className="mono muted command-inspector__meta">{labels.spalten.zuletzt} {relativeZeit(initial.zuletztVerwendetAt, labels)}</span></div>
      <label>
        {labels.text}
        <textarea value={text} onChange={(event) => { setText(event.target.value); }} disabled={busy} />
      </label>
      <label>
        {labels.abkuehlung}
        <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} disabled={busy} />
      </label>
      <div className="form-actions">
        <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={busy}>{labels.speichern(initial.name)}</button>
        <button className="button button--quiet" type="button" onClick={() => { void remove(); }} disabled={busy}>{labels.loeschen(initial.name)}</button>
      </div>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </section>
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

const TextbefehlZeile = ({ initial, language, selected, onSelect }: TextbefehlZeileProperties): ReactElement => {
  const labels = textbefehleTexte(language);
  return (
    <tr tabIndex={0} aria-selected={selected} onClick={onSelect} onKeyDown={(event) => { commandRowKeyDown(event, onSelect); }}>
      <th scope="row" className="mono">!{initial.name}</th>
      <td className="tabelle__answer" title={initial.text}>{initial.text}</td>
      <td className="mono">{initial.cooldownSekunden}</td>
      <td className="tabelle__last-used">{relativeZeit(initial.zuletztVerwendetAt, labels)}</td>
    </tr>
  );
};

export const TextbefehlePanel = ({ channelId, language }: { channelId: string; language?: DashboardLanguage }): ReactElement => {
  const labels = textbefehleTexte(language);
  const [befehle, setBefehle] = useState<Textbefehl[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [cooldownSekunden, setCooldownSekunden] = useState(5);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const data = await ladeTextbefehle(channelId);
      setBefehle(data);
      setSelectedName((current) => current !== null && data.some((befehl) => befehl.name === current) ? current : null);
    } catch {
      setError(labels.fehler);
    } finally {
      setLoading(false);
    }
  }, [channelId, labels.fehler]);

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
  const nameValid = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name.trim());
  const canCreate = nameValid && text.trim().length > 0;

  const create = async (): Promise<void> => {
    if (!canCreate) return;
    setError(null);
    try {
      await legeTextbefehlAn(channelId, { name: name.trim(), text, cooldownSekunden });
      setName("");
      setText("");
      setCooldownSekunden(5);
      await load();
    } catch {
      setError(labels.speichernFehler);
    }
  };

  return (
    <section className="module-stack command-panel" aria-label={labels.titel}>
      <section className="command-list" aria-label={labels.liste}>
        <div className="inspector-section__heading"><h2>{labels.liste}</h2></div>
        {loading ? <p className="loading-line">{labels.laden}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {!loading && error === null && befehle.length === 0 ? <p className="empty-state">{labels.leer}</p> : null}
        {!loading && error === null && befehle.length > 0 ? <div className="tabelle-wrap"><table className="tabelle"><thead><tr><th scope="col">{labels.spalten.name}</th><th scope="col">{labels.spalten.text}</th><th scope="col">{labels.spalten.abkuehlung}</th><th scope="col">{labels.spalten.zuletzt}</th></tr></thead><tbody>{befehle.map((befehl) => <TextbefehlZeile key={befehl.name} channelId={channelId} language={language} initial={befehl} selected={selectedName === befehl.name} onSelect={() => { setSelectedName(befehl.name); }} onChanged={load} />)}</tbody></table></div> : null}
      </section>
      {selected === null ? null : <TextbefehlEditor channelId={channelId} language={language} initial={selected} onChanged={load} />}
      <form className="command-create inspector-section" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="inspector-section__heading"><h2>{labels.anlegen}</h2></div>
        <label>
          {labels.name}
          <input aria-label={labels.name} value={name} onChange={(event) => { setName(event.target.value); }} pattern="[a-z0-9][a-z0-9_-]{0,31}" />
          <span className="muted">{labels.nameHinweis}</span>
        </label>
        <label>
          {labels.text}
          <textarea aria-label={labels.text} value={text} onChange={(event) => { setText(event.target.value); }} />
        </label>
        <label>
          {labels.abkuehlung}
          <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} />
        </label>
        <div className="form-actions form-actions--create"><button className={canCreate ? "button button--primary" : "button"} type="submit" disabled={!canCreate}>{labels.anlegen}</button>{canCreate ? null : <span className="form-hint">{nameValid ? labels.antwortFehlt : labels.nameAntwortFehlt}</span>}</div>
      </form>
    </section>
  );
};

export default TextbefehlePanel;
