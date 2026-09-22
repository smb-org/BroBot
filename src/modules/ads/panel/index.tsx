import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import type { AdsSettings, AdsScheduleResponse } from "../contracts";
import { loadAdSettings, loadAdsSchedule, snoozeAds, saveAdSettings } from "./service";
import { adsPanelTexts } from "./locale";

interface AdsPanelProperties {
  channelId: string;
  language?: DashboardLanguage;
  canManage?: boolean;
}

type AdsPanelSettings = Omit<AdsSettings, "leadSeconds"> & { leadSeconds: number | "" };

const formatTimestamp = (value: string | null, language: DashboardLanguage): string => {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

export const AdsPanel = ({
  channelId,
  language,
  canManage = true,
}: AdsPanelProperties): ReactElement => {
  const labels = adsPanelTexts(language);
  const resolvedLanguage = language ?? (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("de") ? "de" : "en");
  const [settings, setSettings] = useState<AdsPanelSettings | null>(null);
  const [zeitplan, setZeitplan] = useState<AdsScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [vorlaufError, setVorlaufError] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([loadAdSettings(channelId), loadAdsSchedule(channelId)]).then(([loadedSettings, loadedZeitplan]) => {
      if (!active) return;
      setSettings(loadedSettings);
      setZeitplan(loadedZeitplan);
    }).catch(() => {
      if (active) setError(labels.fehler);
    });
    return () => { active = false; };
  }, [channelId, labels.fehler]);

  if (settings === null || zeitplan === null) return <p className="loading-line">{error ?? labels.laden}</p>;

  const save = async (): Promise<void> => {
    if (settings.leadSeconds === "") {
      setVorlaufError(true);
      return;
    }
    setVorlaufError(false);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await saveAdSettings(channelId, { ...settings, leadSeconds: settings.leadSeconds });
      setSaved(true);
    } catch {
      setError(labels.fehler);
    } finally {
      setBusy(false);
    }
  };

  const snoozeCount = zeitplan.schedule.snoozeCount;
  const snoozeButtonDisabled = snoozeBusy || !zeitplan.snoozeScopeVorhanden || snoozeCount === null || snoozeCount <= 0;
  const snoozeReason = !zeitplan.snoozeScopeVorhanden
    ? labels.snoozeScopeFehlt
    : snoozeCount === null
      ? labels.snoozeUnbekannt
      : snoozeCount <= 0 ? labels.snoozeKeine : null;
  const snooze = async (): Promise<void> => {
    setSnoozeBusy(true);
    setError(null);
    try {
      setZeitplan(await snoozeAds(channelId));
    } catch {
      setError(labels.fehler);
    } finally {
      setSnoozeBusy(false);
    }
  };

  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
    formatTimestamp(zeitplan.schedule.snoozeRefreshAt, resolvedLanguage),
  );

  return (
    <section className="module-stack" aria-label={labels.titel}>
      <section className="config-section" aria-label={labels.zeitplanAbschnitt}>
        <div className="section-heading"><h2>{labels.zeitplanAbschnitt}</h2></div>
        {zeitplan.schedule.nextAdAt === null ? <p className="empty-state">{labels.keineWerbung}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle" aria-label={labels.zeitplanAbschnitt}>
              <thead><tr><th scope="col">{labels.naechsteWerbung}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody><tr>
                <td className="zahl">{formatTimestamp(zeitplan.schedule.nextAdAt, resolvedLanguage)}</td>
                <td className="zahl">{zeitplan.schedule.duration === null ? "—" : `${String(zeitplan.schedule.duration)} s`}</td>
              </tr></tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-section" aria-label={labels.automatischAbschnitt}>
        <div className="section-heading"><h2>{labels.automatischAbschnitt}</h2></div>
        <label className="config-field config-field--breit">
          {labels.automatic}
          <textarea
            value={settings.automatic}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, automatic: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalter}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.manuellAbschnitt}>
        <div className="section-heading"><h2>{labels.manuellAbschnitt}</h2></div>
        <label className="config-field config-field--breit">
          {labels.manual}
          <textarea
            value={settings.manual}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, manual: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalter}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.vorwarnungAbschnitt}>
        <div className="section-heading"><h2>{labels.vorwarnungAbschnitt}</h2></div>
        <label className="config-field config-field--breit">
          <span>{labels.vorwarnungAktiv}</span>
          <button
            className="switch"
            type="button"
            role="switch"
            aria-label={labels.vorwarnungAktiv}
            aria-checked={settings.prewarning}
            disabled={!canManage || busy}
            onClick={() => { setSaved(false); setSettings({ ...settings, prewarning: !settings.prewarning }); }}
          >
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
        </label>
        <label className="config-field config-field--schmal">
          {labels.leadSeconds}
          <input
            type="number"
            min="30"
            max="300"
            step="1"
            value={settings.leadSeconds}
            aria-invalid={vorlaufError}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setVorlaufError(false); setSettings({ ...settings, leadSeconds: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {vorlaufError ? <span className="form-error" role="alert">{labels.zahlFehlt}</span> : null}
        </label>
        <label className="config-field config-field--breit">
          {labels.prewarningText}
          <input
            type="search"
            value={settings.prewarningText}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, prewarningText: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.platzhalterVorwarnung}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.snoozeAbschnitt}>
        <div className="section-heading"><h2>{labels.snoozeAbschnitt}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" disabled={snoozeButtonDisabled} onClick={() => { void snooze(); }}>
            {snoozeLabel}
          </button>
        </div>
        {snoozeReason === null ? null : <p className="sperrgrund">{snoozeReason}</p>}
      </section>

      <section className="config-section" aria-label={labels.letzteAbschnitt}>
        <div className="section-heading"><h2>{labels.letzteAbschnitt}</h2></div>
        {zeitplan.letzteWerbepausen.length === 0 ? <p className="empty-state">{labels.keineLetzte}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle" aria-label={labels.letzteAbschnitt}>
              <thead><tr><th scope="col">{labels.naechsteWerbung}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody>{zeitplan.letzteWerbepausen.map((pause) => (
                <tr key={`${pause.zeitpunkt}-${String(pause.dauerSekunden)}`}>
                  <td className="zahl">{labels.letzteZeit(formatTimestamp(pause.zeitpunkt, resolvedLanguage))}</td>
                  <td className="zahl">{labels.letzteDauer(String(pause.dauerSekunden))}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-section" aria-label={labels.aktionen}>
        <div className="section-heading"><h2>{labels.aktionen}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={!canManage || busy}>{labels.speichern}</button>
          {saved ? <span className="muted" role="status">{labels.gespeichert}</span> : null}
        </div>
      </section>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </section>
  );
};

export default AdsPanel;
