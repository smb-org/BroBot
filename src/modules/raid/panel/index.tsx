import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import type { RaidSettings } from "../contracts";
import { ladeRaidEinstellungen, speichereRaidEinstellungen } from "./service";
import { raidPanelTexte } from "./locale";

interface RaidPanelProperties {
  channelId: string;
  language?: DashboardLanguage;
  canManage?: boolean;
}

export const RaidPanel = ({
  channelId,
  language,
  canManage = true,
}: RaidPanelProperties): ReactElement => {
  const labels = raidPanelTexte(language);
  const [settings, setSettings] = useState<RaidSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void ladeRaidEinstellungen(channelId).then((loaded) => {
      if (active) setSettings(loaded);
    }).catch(() => {
      if (active) setError(labels.fehler);
    });
    return () => { active = false; };
  }, [channelId, labels.fehler]);

  if (settings === null) return <p className="loading-line">{error ?? labels.laden}</p>;

  const disabled = !canManage || busy;
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await speichereRaidEinstellungen(channelId, settings);
      setSaved(true);
    } catch {
      setError(labels.fehler);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.titel}>
      {!canManage ? <p className="sperrgrund">{labels.verwaltungGesperrt}</p> : null}
      <section className="config-section" aria-label={labels.schwelleAbschnitt}>
        <div className="section-heading"><h2>{labels.schwelleAbschnitt}</h2></div>
        <label className="config-field config-field--schmal">
          {labels.mindestZuschauer}
          <input
            aria-label={labels.mindestZuschauer}
            type="number"
            min="0"
            max="100000"
            step="1"
            value={settings.mindestZuschauer}
            disabled={disabled}
            onChange={(event) => { setSettings({ ...settings, mindestZuschauer: Number(event.target.value) }); }}
          />
        </label>
        <label className="config-field config-field--breit">
          {labels.vollerText}
          <textarea
            aria-label={labels.vollerText}
            value={settings.textVoll}
            disabled={disabled}
            onChange={(event) => { setSettings({ ...settings, textVoll: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalterVoll}</span>
        </label>
        <label className="config-field config-field--breit">
          {labels.kurzerText}
          <textarea
            aria-label={labels.kurzerText}
            value={settings.textKlein}
            disabled={disabled}
            onChange={(event) => { setSettings({ ...settings, textKlein: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalterKlein}</span>
        </label>
      </section>
      <section className="config-section" aria-label={labels.aktionen}>
        <div className="section-heading"><h2>{labels.aktionen}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={disabled}>{labels.speichern}</button>
          {saved ? <span className="muted" role="status">{labels.gespeichert}</span> : null}
        </div>
      </section>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </section>
  );
};

export default RaidPanel;
