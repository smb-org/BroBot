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

type RaidPanelSettings = Omit<RaidSettings, "shoutoutSchwelle" | "textSchwelle"> & {
  shoutoutSchwelle: number | "";
  textSchwelle: number | "";
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
  const [numberErrors, setNumberErrors] = useState({ shoutoutSchwelle: false, textSchwelle: false });

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
  const shoutoutSchwelleDeaktiviert = disabled || !settings.shoutoutAktiv;
  const save = async (): Promise<void> => {
    if (typeof settings.shoutoutSchwelle !== "number" || typeof settings.textSchwelle !== "number") {
      setNumberErrors({
        shoutoutSchwelle: typeof settings.shoutoutSchwelle !== "number",
        textSchwelle: typeof settings.textSchwelle !== "number",
      });
      return;
    }
    const shoutoutSchwelle = settings.shoutoutSchwelle;
    const textSchwelle = settings.textSchwelle;
    setNumberErrors({ shoutoutSchwelle: false, textSchwelle: false });
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await speichereRaidEinstellungen(channelId, {
        ...settings,
        shoutoutSchwelle,
        textSchwelle,
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
          <span>{labels.shoutoutAktiv}</span>
          <button
            className="switch"
            type="button"
            role="switch"
            aria-label={labels.schalter(settings.shoutoutAktiv)}
            aria-checked={settings.shoutoutAktiv}
            aria-busy={busy}
            disabled={disabled}
            onClick={() => { setSaved(false); setSettings({ ...settings, shoutoutAktiv: !settings.shoutoutAktiv }); }}
          >
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
        </label>
        <label className="config-field config-field--schmal">
          {labels.shoutoutSchwelle}
          <input
            aria-label={labels.shoutoutSchwelle}
            type="number"
            min="0"
            max="100000"
            step="1"
            value={settings.shoutoutSchwelle}
            aria-invalid={numberErrors.shoutoutSchwelle}
            disabled={shoutoutSchwelleDeaktiviert}
            onChange={(event) => { setSaved(false); setNumberErrors({ ...numberErrors, shoutoutSchwelle: false }); setSettings({ ...settings, shoutoutSchwelle: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {numberErrors.shoutoutSchwelle ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
        </label>
        <label className="config-field config-field--schmal">
          {labels.textSchwelle}
          <input
            aria-label={labels.textSchwelle}
            type="number"
            min="0"
            max="100000"
            step="1"
            value={settings.textSchwelle}
            aria-invalid={numberErrors.textSchwelle}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setNumberErrors({ ...numberErrors, textSchwelle: false }); setSettings({ ...settings, textSchwelle: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {numberErrors.textSchwelle ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
        </label>
        <label className="config-field config-field--breit">
          {labels.vollerText}
          <textarea
            aria-label={labels.vollerText}
            value={settings.textVoll}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, textVoll: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalterVoll}</span>
        </label>
        <label className="config-field config-field--breit">
          {labels.kurzerText}
          <textarea
            aria-label={labels.kurzerText}
            value={settings.textKlein}
            disabled={disabled}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, textKlein: event.target.value }); }}
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
