import { useEffect, useRef, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button, EmptyCellValue, Icon, LoadState, Skeleton, notify } from "../../../dashboard/ui";
import type { AdsScheduleResponse } from "../contracts";
import { loadAdsSchedule, snoozeAds } from "./service";
import { adsPanelTexts } from "./locale";

const pickNewestSchedule = (left: AdsScheduleResponse, right: AdsScheduleResponse): AdsScheduleResponse =>
  Date.parse(left.asOf ?? "") >= Date.parse(right.asOf ?? "") ? left : right;

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
  const loadError = labels.loadError;
  const [schedule, setSchedule] = useState<AdsScheduleResponse | null>(null);
  const latestRealtimeRef = useRef<{ schedule: AdsScheduleResponse["schedule"]; asOf: string } | null>(null);
  const [loadStatus, setLoadStatus] = useState<"loading" | "error" | "success">("loading");
  const [snoozeBusy, setSnoozeBusy] = useState(false);

  useEffect(() => {
    let active = true;
    latestRealtimeRef.current = null;
    void loadAdsSchedule(channelId).then((loaded) => {
      if (!active) return;
      setSchedule((current) => {
        const updates = [loaded, ...(current === null ? [] : [current])];
        const buffered = latestRealtimeRef.current;
        if (buffered !== null) {
          const newest = updates.reduce((newestSoFar, candidate) => pickNewestSchedule(newestSoFar, candidate), loaded);
          if (Date.parse(buffered.asOf) > Date.parse(newest.asOf ?? "")) {
            return { ...loaded, schedule: buffered.schedule, asOf: buffered.asOf };
          }
        }
        return updates.reduce((newestSoFar, candidate) => pickNewestSchedule(newestSoFar, candidate), loaded);
      });
      setLoadStatus("success");
    }).catch(() => { if (active) { setLoadStatus("error"); notify({ tone: "error", message: loadError }); } });
    return () => { active = false; };
  }, [channelId, loadError]);

  useEffect(() => {
    const handleRealtimeMessage = (event: Event): void => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return;
      const message = detail as Record<string, unknown>;
      if (message.type !== "ads.schedule.updated" || message.channelId !== channelId ||
          typeof message.payload !== "object" || message.payload === null || Array.isArray(message.payload)) return;
      const payload = message.payload as Record<string, unknown>;
      if (typeof payload.asOf !== "string" || typeof payload.schedule !== "object" || payload.schedule === null || Array.isArray(payload.schedule)) return;
      const update = { schedule: payload.schedule as AdsScheduleResponse["schedule"], asOf: payload.asOf };
      const buffered = latestRealtimeRef.current;
      if (buffered === null || Date.parse(update.asOf) > Date.parse(buffered.asOf)) latestRealtimeRef.current = update;
      setSchedule((current) => current === null || Date.parse(update.asOf) <= Date.parse(current.asOf ?? "") ? current : {
        ...current,
        schedule: update.schedule,
        asOf: update.asOf,
      });
    };
    window.addEventListener("brobot:realtime", handleRealtimeMessage);
    return () => window.removeEventListener("brobot:realtime", handleRealtimeMessage);
  }, [channelId]);

  const snoozeCount = schedule?.schedule.snoozeCount ?? null;
  const snoozeButtonDisabled = schedule === null || snoozeBusy || !schedule.snoozeScopeAvailable || snoozeCount === null || snoozeCount <= 0;
  const snoozeReason = schedule === null ? ""
    : !schedule.snoozeScopeAvailable
    ? labels.snoozeScopeMissing
    : snoozeCount === null
      ? labels.snoozeUnknown
      : snoozeCount <= 0 ? labels.snoozeNone : "";
  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
    formatTimestamp(schedule?.schedule.snoozeRefreshAt ?? null, language),
  );
  const snooze = async (): Promise<void> => {
    if (schedule === null) return;
    setSnoozeBusy(true);
    try {
      setSchedule(await snoozeAds(channelId));
      notify({ tone: "success", message: labels.snoozeSuccess });
    } catch {
      notify({ tone: "error", message: labels.snoozeError });
    } finally {
      setSnoozeBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.title} style={{ minHeight: "calc(var(--s10) * 24)" }}>
      <LoadState status={loadStatus} minHeight="calc(var(--s10) * 24)"
        loading={<div className="module-stack" aria-label={labels.loading}>
          <Skeleton rows={4} height={34} />
          <Skeleton rows={3} height={34} />
          <Skeleton rows={4} height={34} />
        </div>}
        empty={<div style={{ minHeight: "calc(var(--s10) * 24)" }} />}
        error={<div className="module-stack" aria-label={labels.title}>
          <Skeleton rows={4} height={34} /><Skeleton rows={3} height={34} /><Skeleton rows={4} height={34} />
        </div>}>
      {schedule === null ? null : <>
      <section className="config-section" aria-label={labels.scheduleSection}>
        <div className="section-heading"><h2>{labels.scheduleSection}</h2></div>
        <p className="muted mono" title={schedule.asOf === undefined ? undefined : labels.asOf(formatTimestamp(schedule.asOf, language))}
          style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }}>
          {schedule.asOf === undefined ? "" : labels.asOf(formatTimestamp(schedule.asOf, language))}
        </p>
        <div data-testid="ads-next-schedule-slot" style={{ height: "calc(var(--s10) * 3)", overflowY: "auto" }}>
          {schedule.schedule.nextAdAt === null ? <p className="empty-state" style={{ height: "calc(var(--s10) * 3)", margin: 0 }}>{labels.noAdBreak} <EmptyCellValue language={language} /></p> : (
          <div className="table-wrap" style={{ height: "calc(var(--s10) * 3)", overflowY: "auto" }}>
            <table className="table" aria-label={labels.scheduleSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody><tr>
                <td className="number">{formatTimestamp(schedule.schedule.nextAdAt, language)}</td>
                <td className="number">{schedule.schedule.duration === null ? <EmptyCellValue language={language} /> : `${String(schedule.schedule.duration)} s`}</td>
              </tr></tbody>
            </table>
          </div>
          )}
        </div>
      </section>
      <section className="config-section" aria-label={labels.snoozeSection}>
        <div className="section-heading"><h2>{labels.snoozeSection}</h2></div>
        <Button variant="secondary" icon="ad" disabled={snoozeButtonDisabled} onClick={() => { void snooze(); }}>{snoozeLabel}</Button>
        <p className="lock-reason lock-reason--with-icon" data-testid="ads-snooze-result-slot"
          title={snoozeReason || undefined} style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0 }} aria-live="polite">
          {snoozeReason.length === 0 ? null : <><Icon name="lock" size={16} />{snoozeReason}</>}
        </p>
      </section>
      <section className="config-section" aria-label={labels.recentSection}>
        <div className="section-heading"><h2>{labels.recentSection}</h2></div>
        <div data-testid="ads-recent-list-slot" style={{ height: "calc(var(--s10) * 6)", overflowY: "auto" }}>
          {schedule.recentAdBreaks.length === 0 ? <p className="empty-state" style={{ height: "calc(var(--s10) * 6)", margin: 0 }}>{labels.noRecent}</p> : (
          <div className="table-wrap" style={{ height: "calc(var(--s10) * 6)", overflowY: "auto" }}>
            <table className="table" aria-label={labels.recentSection}>
              <thead><tr><th scope="col">{labels.scheduledTime}</th><th scope="col">{labels.duration}</th></tr></thead>
              <tbody>{schedule.recentAdBreaks.map((breakItem) => <tr key={`${breakItem.timestamp}-${String(breakItem.durationSeconds)}`}>
                <td className="number">{formatTimestamp(breakItem.timestamp, language)}</td>
                <td className="number">{labels.recentDuration(String(breakItem.durationSeconds))}</td>
              </tr>)}</tbody>
            </table>
          </div>
          )}
        </div>
      </section>
      </>}
      </LoadState>
    </section>
  );
};

export default AdsPanel;
