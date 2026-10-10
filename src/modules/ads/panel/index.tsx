import { useRef, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import type { AdsScheduleResponse } from "../contracts";
import { Button, EmptyCellValue, Icon, LoadState, Skeleton, notify } from "../../../dashboard/ui";
import { loadAdsSchedule, refreshAdsSchedule, snoozeAds } from "./service";
import { adsPanelTexts } from "./locale";
import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryError, useModuleQuery } from "../../../dashboard/data";
import { useDashboardQueryClient } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

const formatTimestamp = (value: string | null, language: DashboardLanguage): string => {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
};

export const AdsPanel = ({ channelId, language = "de", canManage = false }: { channelId: string; language?: DashboardLanguage; canManage?: boolean }): ReactElement => {
  const labels = adsPanelTexts(language);
  const loadError = labels.loadError;
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const scheduleError = useDashboardQueryError(moduleQueryKey(channelId, "ads", "schedule"));
  const loadErrorNotified = useRef(false);
  const readSchedule = async (signal: AbortSignal): Promise<AdsScheduleResponse> => {
    try {
      const response = await loadAdsSchedule(channelId, signal);
      loadErrorNotified.current = false;
      return response;
    } catch (failure: unknown) {
      if (!loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: loadError });
      }
      throw failure;
    }
  };
  const scheduleQuery = useModuleQuery(channelId, "ads", "schedule", readSchedule, {
    refetchInterval: realtimeStatus === "connected" ? false : 60_000,
  });
  const schedule = scheduleQuery.data ?? null;
  const scheduleLoadFailed = scheduleError !== null;
  const loadStatus = schedule === null
    ? scheduleQuery.isPending ? "loading" : scheduleLoadFailed ? "error" : "loading"
    : "success";
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);

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
      await runModuleQueryWrite(queryClient, channelId, "ads", "schedule", () => snoozeAds(channelId), {
        baselineRevision: null,
        updateCache: (_current, result) => result,
      });
      notify({ tone: "success", message: labels.snoozeSuccess });
    } catch {
      notify({ tone: "error", message: labels.snoozeError });
    } finally {
      setSnoozeBusy(false);
    }
  };
  const refreshSchedule = async (): Promise<void> => {
    if (!canManage || refreshBusy) return;
    setRefreshBusy(true);
    try {
      await runModuleQueryWrite(queryClient, channelId, "ads", "schedule", () => refreshAdsSchedule(channelId), {
        baselineRevision: null,
        updateCache: (_current, result) => result,
      });
      notify({ tone: "success", message: labels.refreshSuccess });
    } catch {
      notify({ tone: "error", message: labels.refreshError });
    } finally {
      setRefreshBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.title} style={{ minHeight: "calc(var(--s10) * 24)" }}>
      <div className="section-heading">
        <h2>{labels.scheduleSection}</h2>
        <Button variant="secondary" disabled={!canManage || refreshBusy} describedBy="ads-schedule-refresh-reason"
          onClick={() => { void refreshSchedule(); }}>{labels.refreshSchedule}</Button>
      </div>
      <p id="ads-schedule-refresh-reason" className="lock-reason" data-testid="ads-schedule-refresh-reason"
        style={{ height: "var(--s6)", overflow: "hidden", margin: 0 }} aria-live="polite">
        {canManage ? "" : labels.refreshReadOnly}
      </p>
      <LoadState status={loadStatus} minHeight="calc(var(--s10) * 24)"
        loading={<div className="module-stack" aria-label={labels.loading}>
          <Skeleton rows={4} height={34} />
          <Skeleton rows={3} height={34} />
          <Skeleton rows={4} height={34} />
        </div>}
        empty={<div style={{ minHeight: "calc(var(--s10) * 24)" }} />}
        error={<p role="alert">{loadError}</p>}
        queryError={{ message: loadError, onRetry: () => { void scheduleQuery.refetch({ throwOnError: true }).catch(() => undefined); } }}
        refreshError={schedule !== null && scheduleLoadFailed}>
      {schedule === null ? null : <>
      <section className="config-section" aria-label={labels.scheduleSection}>
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
