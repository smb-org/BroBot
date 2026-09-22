import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Field, NumberField, SaveBar, Switch, useDraft } from "../../../dashboard/ui";
import type { AdsSettings, AdsScheduleResponse } from "../contracts";
import { loadAdSettings, loadAdsSchedule, snoozeAds, saveAdSettings } from "./service";
import { adsPanelTexts, type AdsPanelTexts } from "./locale";

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

interface AdsFormProperties {
  channelId: string;
  labels: AdsPanelTexts;
  canManage: boolean;
  language: DashboardLanguage;
  initial: AdsPanelSettings;
  schedule: AdsScheduleResponse;
  onScheduleChange: (schedule: AdsScheduleResponse) => void;
  /** See `RaidForm`'s identical `onSaved`: feeds the just-saved value back
   *  in as the next `initial` so `dirty` clears without a remount. */
  onSaved: (settings: AdsPanelSettings) => void;
}

const AdsForm = ({ channelId, labels, canManage, language, initial, schedule, onScheduleChange, onSaved }: AdsFormProperties): ReactElement => {
  const { value: settings, setValue: setSettings, dirty, reset } = useDraft<AdsPanelSettings>(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [leadSecondsError, setLeadSecondsError] = useState(false);

  const change = (next: Partial<AdsPanelSettings>): void => {
    setSaved(false);
    setSettings((current) => ({ ...current, ...next }));
  };

  const save = async (): Promise<void> => {
    if (settings.leadSeconds === "") {
      setLeadSecondsError(true);
      return;
    }
    setLeadSecondsError(false);
    setBusy(true);
    setError(undefined);
    setSaved(false);
    const savedSettings = { ...settings, leadSeconds: settings.leadSeconds };
    try {
      await saveAdSettings(channelId, savedSettings);
      onSaved(savedSettings);
      setSaved(true);
    } catch {
      setError(labels.error);
    } finally {
      setBusy(false);
    }
  };

  const discard = (): void => {
    reset();
    setSaved(false);
    setLeadSecondsError(false);
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
    setError(undefined);
    try {
      onScheduleChange(await snoozeAds(channelId));
    } catch {
      setError(labels.error);
    } finally {
      setSnoozeBusy(false);
    }
  };

  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
    formatTimestamp(schedule.schedule.snoozeRefreshAt, language),
  );

  const disabled = !canManage || busy;

  return (
    <section className="module-stack" aria-label={labels.title}>
      <section className="config-section" aria-label={labels.scheduleSection}>
        <div className="section-heading"><h2>{labels.scheduleSection}</h2></div>
        {schedule.schedule.nextAdAt === null ? <p className="empty-state">{labels.noAdBreak}</p> : (
          <div className="table-wrap">
            <table className="table" aria-label={labels.scheduleSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody><tr>
                <td className="number">{formatTimestamp(schedule.schedule.nextAdAt, language)}</td>
                <td className="number">{schedule.schedule.duration === null ? "—" : `${String(schedule.schedule.duration)} s`}</td>
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
            disabled={disabled}
            onChange={(event) => { change({ automatic: event.target.value }); }}
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
            disabled={disabled}
            onChange={(event) => { change({ manual: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.durationPlaceholderHint}</span>
        </label>
      </section>

      <section className="config-section" aria-label={labels.warningSection}>
        <div className="section-heading"><h2>{labels.warningSection}</h2></div>
        <div style={{ display: "grid", gap: "6px", maxWidth: "var(--config-field-breit)" }}>
          <span>{labels.warningEnabled}</span>
          <Switch
            ariaLabel={labels.warningEnabled}
            checked={settings.prewarning}
            disabled={disabled}
            onChange={(checked) => { change({ prewarning: checked }); }}
          />
        </div>
        <div className="config-field--schmal">
          <NumberField
            label={labels.leadSeconds}
            value={settings.leadSeconds}
            onChange={(value) => { setLeadSecondsError(false); change({ leadSeconds: value }); }}
            min={30}
            max={300}
            disabled={disabled}
            {...(leadSecondsError ? { error: labels.numberMissing } : {})}
          />
        </div>
        <div className="config-field--breit">
          <Field
            label={labels.prewarningText}
            value={settings.prewarningText}
            onChange={(value) => { change({ prewarningText: value }); }}
            disabled={disabled}
            hint={labels.warningPlaceholderHint}
          />
        </div>
      </section>

      <section className="config-section" aria-label={labels.snoozeSection}>
        <div className="section-heading"><h2>{labels.snoozeSection}</h2></div>
        <div className="form-actions">
          <button className="button button--primary" type="button" disabled={snoozeButtonDisabled} onClick={() => { void snooze(); }}>
            {snoozeLabel}
          </button>
        </div>
        {snoozeReason === null ? null : <p className="lock-reason">{snoozeReason}</p>}
      </section>

      <section className="config-section" aria-label={labels.recentSection}>
        <div className="section-heading"><h2>{labels.recentSection}</h2></div>
        {schedule.recentAdBreaks.length === 0 ? <p className="empty-state">{labels.noRecent}</p> : (
          <div className="table-wrap">
            <table className="table" aria-label={labels.recentSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody>{schedule.recentAdBreaks.map((adBreak) => (
                <tr key={`${adBreak.timestamp}-${String(adBreak.durationSeconds)}`}>
                  <td className="number">{labels.recentTime(formatTimestamp(adBreak.timestamp, language))}</td>
                  <td className="number">{labels.recentDuration(String(adBreak.durationSeconds))}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="config-section" aria-label={labels.actions}>
        <div className="section-heading"><h2>{labels.actions}</h2></div>
        <SaveBar
          dirty={dirty}
          pending={busy}
          {...(error !== undefined ? { error } : {})}
          saved={saved}
          onSave={() => { void save(); }}
          onDiscard={discard}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
      </section>
    </section>
  );
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

  return (
    <AdsForm
      key={channelId}
      channelId={channelId}
      labels={labels}
      canManage={canManage}
      language={resolvedLanguage}
      initial={settings}
      schedule={schedule}
      onScheduleChange={setSchedule}
      onSaved={setSettings}
    />
  );
};

export default AdsPanel;
