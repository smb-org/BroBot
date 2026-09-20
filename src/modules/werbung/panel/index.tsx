import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import type { WerbungSettings } from "../contracts";
import { ladeWerbungseinstellungen, speichereWerbungseinstellungen } from "./service";
import { werbungPanelTexte } from "./locale";

export const WerbungPanel = ({ channelId, language }: { channelId: string; language?: DashboardLanguage }): ReactElement => {
  const labels = werbungPanelTexte(language);
  const [settings, setSettings] = useState<WerbungSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void ladeWerbungseinstellungen(channelId).then((loaded) => {
      if (active) setSettings(loaded);
    }).catch(() => {
      if (active) setError(labels.fehler);
    });
    return () => { active = false; };
  }, [channelId, labels.fehler]);

  if (settings === null) return <p className="loading-line">{error ?? labels.laden}</p>;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await speichereWerbungseinstellungen(channelId, settings);
      setSaved(true);
    } catch {
      setError(labels.fehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.titel}>
      <section className="config-section" aria-label={labels.automatischAbschnitt}>
        <div className="section-heading"><h2>{labels.automatischAbschnitt}</h2></div>
        <label className="config-field config-field--breit">
          {labels.automatisch}
          <textarea value={settings.automatisch} disabled={busy} onChange={(event) => { setSettings({ ...settings, automatisch: event.target.value }); }} />
          <span className="config-field__hint">{labels.platzhalter}</span>
        </label>
      </section>
      <section className="config-section" aria-label={labels.manuellAbschnitt}>
        <div className="section-heading"><h2>{labels.manuellAbschnitt}</h2></div>
        <label className="config-field config-field--breit">
          {labels.manuell}
          <textarea value={settings.manuell} disabled={busy} onChange={(event) => { setSettings({ ...settings, manuell: event.target.value }); }} />
          <span className="config-field__hint">{labels.platzhalter}</span>
        </label>
      </section>
      <section className="config-section" aria-label={labels.aktionen}>
        <div className="section-heading"><h2>{labels.aktionen}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={busy}>{labels.speichern}</button>
          {saved ? <span className="muted" role="status">{labels.gespeichert}</span> : null}
        </div>
      </section>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </section>
  );
};

export default WerbungPanel;
