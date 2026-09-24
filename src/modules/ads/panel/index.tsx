import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button, Icon } from "../../../dashboard/ui";
import type { AdsScheduleResponse } from "../contracts";
import { loadAdsSchedule, snoozeAds } from "./service";
import { adsPanelTexts } from "./locale";

const formatTimestamp = (value: string | null, language: DashboardLanguage): string => {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

export const AdsPanel = ({ channelId, language = "de" }: { channelId: string; language?: DashboardLanguage }): ReactElement => {
  const labels = adsPanelTexts(language);
  const [schedule, setSchedule] = useState<AdsScheduleResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeOutcome, setSnoozeOutcome] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    let active = true;
    void loadAdsSchedule(channelId).then((loaded) => {
      if (!active) return;
      setSchedule((current) => current !== null && Date.parse(current.asOf ?? "") > Date.parse(loaded.asOf ?? "") ? current : loaded);
      setLoadError(false);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [channelId]);

  useEffect(() => {
    const handleRealtimeMessage = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return;
      const message = detail as Record<string, unknown>;
      if (message.type !== "ads.schedule.updated" || message.channelId !== channelId ||
          typeof message.payload !== "object" || message.payload === null || Array.isArray(message.payload)) return;
      const payload = message.payload as Record<string, unknown>;
      if (typeof payload.asOf !== "string" || typeof payload.schedule !== "object" || payload.schedule === null || Array.isArray(payload.schedule)) return;
      setSchedule((current) => current === null ? current : {
        ...current,
        schedule: payload.schedule as AdsScheduleResponse["schedule"],
        asOf: payload.asOf as string,
      });
    };
    window.addEventListener("brobot:realtime", handleRealtimeMessage);
    return () => window.removeEventListener("brobot:realtime", handleRealtimeMessage);
  }, [channelId]);

  if (schedule === null) return <p className={loadError ? "form-error" : "loading-line"} role={loadError ? "alert" : undefined}>{loadError ? labels.loadError : labels.loading}</p>;

  const snoozeCount = schedule.schedule.snoozeCount;
  const snoozeButtonDisabled = snoozeBusy || !schedule.snoozeScopeAvailable || snoozeCount === null || snoozeCount <= 0;
  const snoozeReason = !schedule.snoozeScopeAvailable
    ? labels.snoozeScopeMissing
    : snoozeCount === null
      ? labels.snoozeUnknown
      : snoozeCount <= 0 ? labels.snoozeNone : null;
  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
    formatTimestamp(schedule.schedule.snoozeRefreshAt, language),
  );
  const snooze = async (): Promise<void> => {
    setSnoozeBusy(true);
    setSnoozeOutcome(null);
    try {
      setSchedule(await snoozeAds(channelId));
      setSnoozeOutcome("success");
    } catch {
      setSnoozeOutcome("error");
    } finally {
      setSnoozeBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.title}>
      <section className="config-section" aria-label={labels.scheduleSection}>
        <div className="section-heading"><h2>{labels.scheduleSection}</h2></div>
        {schedule.asOf === undefined ? null : <p className="muted mono">{labels.asOf(formatTimestamp(schedule.asOf, language))}</p>}
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
      <section className="config-section" aria-label={labels.snoozeSection}>
        <div className="section-heading"><h2>{labels.snoozeSection}</h2></div>
        <Button variant="secondary" icon="ad" disabled={snoozeButtonDisabled} onClick={() => { void snooze(); }}>{snoozeLabel}</Button>
        {snoozeReason === null ? null : <p className="lock-reason lock-reason--with-icon"><Icon name="lock" size={16} />{snoozeReason}</p>}
        {snoozeOutcome === null ? null : <p className={snoozeOutcome === "success" ? "form-success" : "form-error"} role={snoozeOutcome === "error" ? "alert" : "status"}>{snoozeOutcome === "success" ? labels.snoozeSuccess : labels.snoozeError}</p>}
      </section>
      <section className="config-section" aria-label={labels.recentSection}>
        <div className="section-heading"><h2>{labels.recentSection}</h2></div>
        {schedule.recentAdBreaks.length === 0 ? <p className="empty-state">{labels.noRecent}</p> : (
          <div className="table-wrap">
            <table className="table" aria-label={labels.recentSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody>{schedule.recentAdBreaks.map((breakItem) => <tr key={`${breakItem.timestamp}-${String(breakItem.durationSeconds)}`}>
                <td className="number">{formatTimestamp(breakItem.timestamp, language)}</td>
                <td className="number">{labels.recentDuration(String(breakItem.durationSeconds))}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
};

export default AdsPanel;
