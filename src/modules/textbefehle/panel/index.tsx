import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { Textbefehl } from "../contracts";
import { loescheTextbefehl, ladeTextbefehle, legeTextbefehlAn, speichereTextbefehl } from "./service";
import { textbefehleTexte } from "./locale";

interface TextbefehlZeileProperties {
  channelId: string;
  initial: Textbefehl;
  onChanged: () => Promise<void>;
}

const TextbefehlZeile = ({ channelId, initial, onChanged }: TextbefehlZeileProperties): ReactElement => {
  const labels = textbefehleTexte();
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
      setError(labels.speichernFehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="content-section">
      <div className="section-heading"><h3>!{initial.name}</h3></div>
      <label>
        {labels.text}
        <textarea value={text} onChange={(event) => { setText(event.target.value); }} disabled={busy} />
      </label>
      <label>
        {labels.abkuehlung}
        <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} disabled={busy} />
      </label>
      <div className="form-actions">
        <button className="button button--secondary" type="button" onClick={() => { void save(); }} disabled={busy}>
          {labels.speichern(initial.name)}
        </button>
        <button className="button button--quiet" type="button" onClick={() => { void remove(); }} disabled={busy}>
          {labels.loeschen(initial.name)}
        </button>
      </div>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </article>
  );
};

export const TextbefehlePanel = ({ channelId }: { channelId: string }): ReactElement => {
  const labels = textbefehleTexte();
  const [befehle, setBefehle] = useState<Textbefehl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [cooldownSekunden, setCooldownSekunden] = useState(5);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setBefehle(await ladeTextbefehle(channelId));
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

  const create = async (): Promise<void> => {
    if (name.trim().length === 0 || text.trim().length === 0) return;
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
    <section className="module-stack" aria-label={labels.titel}>
      <header className="section-heading"><h2>{labels.titel}</h2></header>
      <form className="content-section" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <h3>{labels.anlegen}</h3>
        <label>
          {labels.name}
          <input value={name} onChange={(event) => { setName(event.target.value); }} pattern="[a-z0-9][a-z0-9_-]{0,31}" required />
          <span className="muted">{labels.nameHinweis}</span>
        </label>
        <label>
          {labels.text}
          <textarea value={text} onChange={(event) => { setText(event.target.value); }} required />
        </label>
        <label>
          {labels.abkuehlung}
          <input type="number" min="0" max="86400" value={cooldownSekunden} onChange={(event) => { setCooldownSekunden(Number(event.target.value)); }} required />
        </label>
        <button className="button button--primary" type="submit">{labels.anlegen}</button>
      </form>
      {loading ? <p className="loading-line">{labels.laden}</p> : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      {!loading && error === null && befehle.length === 0 ? <p className="muted">{labels.leer}</p> : null}
      {befehle.map((befehl) => (
        <TextbefehlZeile key={befehl.name} channelId={channelId} initial={befehl} onChanged={load} />
      ))}
    </section>
  );
};

export default TextbefehlePanel;
