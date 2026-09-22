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

type RaidPanelSettings = Omit<RaidSettings, "shoutoutThreshold" | "textThreshold"> & {
  shoutoutThreshold: number | "";
  textThreshold: number | "";
};

export const RaidPanel = ({
  channelId,
  language,
  canManage = true,
}: RaidPanelProperties): ReactElement => {
  const labels = raidPanelTexte(language);
  const [settings, setSettings] = useState<RaidPanelSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [numberErrors, setNumberErrors] = useState({ shoutoutThreshold: false, textThreshold: false });

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
  const shoutoutSchwelleDeaktiviert = disabled || !settings.shoutoutEnabled;
  const save = async (): Promise<void> => {
    if (typeof settings.shoutoutThreshold !== "number" || typeof settings.textThreshold !== "number") {
      setNumberErrors({
        shoutoutThreshold: typeof settings.shoutoutThreshold !== "number",
        textThreshold: typeof settings.textThreshold !== "number",
      });
      return;
    }
    const shoutoutSchwelle = settings.shoutoutThreshold;
    const textSchwelle = settings.textThreshold;
    setNumberErrors({ shoutoutThreshold: false, textThreshold: false });
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await speichereRaidEinstellungen(channelId, {
        ...settings,
        shoutoutThreshold: shoutoutSchwelle,
        textThreshold: textSchwelle,
      });
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
        <label className="config-field config-field--breit">
          <span>{labels.shoutoutEnabled}</span>
          <button
            className="switch"
            type="button"
            role="switch"
            aria-label={labels.schalter(settings.shoutoutEnabled)}
            aria-checked={settings.shoutoutEnabled}
            aria-busy={busy}
            disabled={disabled}
            onClick={() => { setSaved(false); setSettings({ ...settings, shoutoutEnabled: !settings.shoutoutEnabled }); }}
          >
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
        </label>
        <label className="config-field config-field--schmal">
          {labels.shoutoutThreshold}
          <input
            aria-label={labels.shoutoutThreshold}
            type="number"
            min="0"
            max="100000"
            step="1"
            value={settings.shoutoutThreshold}
            aria-invalid={numberErrors.shoutoutThreshold}
            disabled={shoutoutSchwelleDeaktiviert}
            onChange={(event) => { setSaved(false); setNumberErrors({ ...numberErrors, shoutoutThreshold: false }); setSettings({ ...settings, shoutoutThreshold: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {numberErrors.shoutoutThreshold ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
        </label>
        <label className="config-field config-field--schmal">
          {labels.textThreshold}
          <input
            aria-label={labels.textThreshold}
            type="number"
            min="0"
            max="100000"
            step="1"
            value={settings.textThreshold}
            aria-invalid={numberErrors.textThreshold}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setNumberErrors({ ...numberErrors, textThreshold: false }); setSettings({ ...settings, textThreshold: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {numberErrors.textThreshold ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
        </label>
        <label className="config-field config-field--breit">
          {labels.vollerText}
          <textarea
            aria-label={labels.vollerText}
            value={settings.textLong}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, textLong: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalterVoll}</span>
        </label>
        <label className="config-field config-field--breit">
          {labels.kurzerText}
          <textarea
            aria-label={labels.kurzerText}
            value={settings.textShort}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, textShort: event.target.value }); }}
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
