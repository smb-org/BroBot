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
  const [schedule, setSchedule] = useState<AdsScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [leadSecondsError, setLeadSecondsError] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([loadAdSettings(channelId), loadAdsSchedule(channelId)]).then(([loadedSettings, loadedSchedule]) => {
      if (!active) return;
      setSettings(loadedSettings);
      setSchedule(loadedSchedule);
    }).catch(() => {
      if (active) setError(labels.error);
    });
    return () => { active = false; };
  }, [channelId, labels.error]);

  if (settings === null || schedule === null) return <p className="loading-line">{error ?? labels.load}</p>;

  const save = async (): Promise<void> => {
    if (settings.leadSeconds === "") {
      setLeadSecondsError(true);
      return;
    }
    setLeadSecondsError(false);
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await saveAdSettings(channelId, { ...settings, leadSeconds: settings.leadSeconds });
      setSaved(true);
    } catch {
      setError(labels.error);
    } finally {
      setBusy(false);
    }
  };

  const snoozeCount = schedule.schedule.snoozeCount;
  const snoozeButtonDisabled = snoozeBusy || !schedule.snoozeScopeAvailable || snoozeCount === null || snoozeCount <= 0;
  const snoozeReason = !schedule.snoozeScopeAvailable
    ? labels.snoozeScopeMissing
    : snoozeCount === null
      ? labels.snoozeUnknown
      : snoozeCount <= 0 ? labels.snoozeNone : null;
  const snooze = async (): Promise<void> => {
    setSnoozeBusy(true);
    setError(null);
    try {
      setSchedule(await snoozeAds(channelId));
    } catch {
      setError(labels.error);
    } finally {
      setSnoozeBusy(false);
    }
  };

  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
    formatTimestamp(schedule.schedule.snoozeRefreshAt, resolvedLanguage),
  );

  return (
    <section className="module-stack" aria-label={labels.title}>
      <section className="config-section" aria-label={labels.scheduleSection}>
        <div className="section-heading"><h2>{labels.scheduleSection}</h2></div>
        {schedule.schedule.nextAdAt === null ? <p className="empty-state">{labels.noAdBreak}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle" aria-label={labels.scheduleSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody><tr>
                <td className="zahl">{formatTimestamp(schedule.schedule.nextAdAt, resolvedLanguage)}</td>
                <td className="zahl">{schedule.schedule.duration === null ? "—" : `${String(schedule.schedule.duration)} s`}</td>
              </tr></tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-section" aria-label={labels.automaticSection}>
        <div className="section-heading"><h2>{labels.automaticSection}</h2></div>
        <label className="config-field config-field--breit">
          {labels.automatic}
          <textarea
            value={settings.automatic}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, automatic: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.durationPlaceholderHint}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.manualSection}>
        <div className="section-heading"><h2>{labels.manualSection}</h2></div>
        <label className="config-field config-field--breit">
          {labels.manual}
          <textarea
            value={settings.manual}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, manual: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.durationPlaceholderHint}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.warningSection}>
        <div className="section-heading"><h2>{labels.warningSection}</h2></div>
        <label className="config-field config-field--breit">
          <span>{labels.warningEnabled}</span>
          <button
            className="switch"
            type="button"
            role="switch"
            aria-label={labels.warningEnabled}
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
            aria-invalid={leadSecondsError}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setLeadSecondsError(false); setSettings({ ...settings, leadSeconds: event.target.value === "" ? "" : Number(event.target.value) }); }}
          />
          {leadSecondsError ? <span className="form-error" role="alert">{labels.numberMissing}</span> : null}
        </label>
        <label className="config-field config-field--breit">
          {labels.prewarningText}
          <input
            type="search"
            value={settings.prewarningText}
            disabled={!canManage || busy}
            onChange={(event) => { setSaved(false); setSettings({ ...settings, prewarningText: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.warningPlaceholderHint}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.snoozeSection}>
        <div className="section-heading"><h2>{labels.snoozeSection}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" disabled={snoozeButtonDisabled} onClick={() => { void snooze(); }}>
            {snoozeLabel}
          </button>
        </div>
        {snoozeReason === null ? null : <p className="sperrgrund">{snoozeReason}</p>}
      </section>

      <section className="config-section" aria-label={labels.recentSection}>
        <div className="section-heading"><h2>{labels.recentSection}</h2></div>
        {schedule.recentAdBreaks.length === 0 ? <p className="empty-state">{labels.noRecent}</p> : (
          <div className="tabelle-wrap">
            <table className="tabelle" aria-label={labels.recentSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody>{schedule.recentAdBreaks.map((adBreak) => (
                <tr key={`${adBreak.timestamp}-${String(adBreak.durationSeconds)}`}>
                  <td className="zahl">{labels.recentTime(formatTimestamp(adBreak.timestamp, resolvedLanguage))}</td>
                  <td className="zahl">{labels.recentDuration(String(adBreak.durationSeconds))}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-section" aria-label={labels.actions}>
        <div className="section-heading"><h2>{labels.actions}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" onClick={() => { void save(); }} disabled={!canManage || busy}>{labels.save}</button>
          {saved ? <span className="muted" role="status">{labels.saved}</span> : null}
        </div>
      </section>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </section>
  );
};

export default AdsPanel;
