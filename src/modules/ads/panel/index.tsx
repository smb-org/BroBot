import { useEffect, useRef, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { PanelApiError } from "../../../contracts/panel-error";
import type { AdsScheduleResponse } from "../contracts";
import { Button, Icon, LoadState, LoadStateLines, notify } from "../../../dashboard/ui";
import { loadAdsSchedule, refreshAdsSchedule, snoozeAds } from "./service";
import { adsPanelTexts } from "./locale";
import { adFailureReason, rateLimitWaitMessage } from "./errors";
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

const formatDueIn = (value: string, language: DashboardLanguage, now: number): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const minutes = Math.round((timestamp - now) / 60_000);
  const unit = Math.abs(minutes) < 60 ? "minute" : Math.abs(minutes) < 1_440 ? "hour" : "day";
  const amount = unit === "minute" ? minutes : unit === "hour" ? Math.round(minutes / 60) : Math.round(minutes / 1_440);
  return new Intl.RelativeTimeFormat(language === "de" ? "de-DE" : "en-US", { numeric: "auto" }).format(amount, unit);
};

const AdsPanel = ({ channelId, language = "de", canManage = false, moduleActive = true }: { channelId: string; language?: DashboardLanguage; canManage?: boolean; moduleActive?: boolean }): ReactElement => {
  const labels = adsPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const scheduleError = useDashboardQueryError(moduleQueryKey(channelId, "ads", "schedule"));
  const loadError = rateLimitWaitMessage(scheduleError, labels) ?? labels.loadError;
  const loadErrorNotified = useRef(false);
  const readSchedule = async (signal: AbortSignal): Promise<AdsScheduleResponse> => {
    try {
      const response = await loadAdsSchedule(channelId, signal);
      loadErrorNotified.current = false;
      return response;
    } catch (failure: unknown) {
      if (!signal.aborted && !loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: rateLimitWaitMessage(failure, labels) ?? labels.loadError });
      }
      throw failure;
    }
  };
  const scheduleQuery = useModuleQuery(channelId, "ads", "schedule", readSchedule, {
    refetchInterval: realtimeStatus === "connected" ? false : 60_000,
  });
  const schedule = scheduleQuery.data ?? null;
  const scheduleLoadFailed = scheduleError !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (schedule?.schedule.nextAdAt === null || schedule?.schedule.nextAdAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [schedule?.schedule.nextAdAt]);
  const scheduleAsOf = schedule?.asOf === undefined ? Number.NaN : Date.parse(schedule.asOf);
  const effectiveNow = Math.max(now, scheduleQuery.dataUpdatedAt, Number.isFinite(scheduleAsOf) ? scheduleAsOf : 0);
  const loadStatus = schedule === null
    ? scheduleQuery.isPending ? "loading" : scheduleLoadFailed ? "error" : "loading"
    : "success";
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeResult, setSnoozeResult] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);

  const snoozeCount = schedule?.schedule.snoozeCount ?? null;
  const snoozeButtonDisabled = schedule === null || !canManage || !moduleActive || snoozeBusy || !schedule.snoozeScopeAvailable || snoozeCount === null || snoozeCount <= 0;
  const snoozeReason = schedule === null ? ""
    : !canManage
    ? labels.snoozeReadOnly
    : !moduleActive
    ? labels.moduleInactive
    : !schedule.snoozeScopeAvailable
    ? labels.snoozeScopeMissing
    : snoozeCount === null
      ? labels.snoozeUnknown
      : snoozeCount <= 0 ? labels.snoozeNone : "";
  const snoozeLabel = labels.snoozeButton(
    snoozeCount === null ? "—" : String(snoozeCount),
  );
  const snoozeRefresh = schedule?.schedule.snoozeRefreshAt === null || schedule?.schedule.snoozeRefreshAt === undefined
    ? null
    : labels.snoozeRefresh(formatTimestamp(schedule.schedule.snoozeRefreshAt, language));
  const snooze = async (): Promise<void> => {
    if (!canManage || !moduleActive || schedule === null) return;
    setSnoozeResult(null);
    setSnoozeBusy(true);
    try {
      await runModuleQueryWrite(queryClient, channelId, "ads", "schedule", () => snoozeAds(channelId), {
        baselineRevision: null,
        updateCache: (_current, result) => result,
      });
      notify({ tone: "success", message: labels.snoozeSuccess });
    } catch (error: unknown) {
      const message = error instanceof PanelApiError && error.code === "ad_snooze_denied"
        ? labels.snoozeReadOnly
        : adFailureReason(error) === "scope_missing"
          ? labels.snoozeScopeMissing
          : adFailureReason(error) === "snoozes_exhausted"
            ? labels.snoozeNone
            : rateLimitWaitMessage(error, labels) ?? labels.snoozeError;
      setSnoozeResult(message);
      notify({ tone: "error", message });
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
    } catch (error: unknown) {
      const message = adFailureReason(error) === "scope_missing"
        ? labels.refreshScopeMissing
        : rateLimitWaitMessage(error, labels) ?? labels.refreshError;
      notify({ tone: "error", message });
    } finally {
      setRefreshBusy(false);
    }
  };

  return (
    <section className="module-stack" aria-label={labels.title}>
      <div className="section-heading">
        <h2>{labels.scheduleSection}</h2>
        <Button variant="secondary" disabled={!canManage || refreshBusy} describedBy="ads-schedule-refresh-reason"
          {...(canManage ? {} : { title: labels.refreshReadOnly })}
          onClick={() => { void refreshSchedule(); }}>{labels.refreshSchedule}</Button>
      </div>
      <p id="ads-schedule-refresh-reason" className="sr-only" data-testid="ads-schedule-refresh-reason" aria-live="polite">
        {canManage ? "" : labels.refreshReadOnly}
      </p>
      <LoadState variant="panel-0" status={loadStatus}
        loading={<div className="module-stack" aria-label={labels.loading}>
          <LoadStateLines rows={4} height={34} />
          <LoadStateLines rows={3} height={34} />
          <LoadStateLines rows={4} height={34} />
        </div>}
        empty={null}
        error={<p role="alert">{loadError}</p>}
        queryError={{ message: loadError, onRetry: () => { void scheduleQuery.refetch({ throwOnError: true }).catch(() => undefined); } }}>
      {schedule === null ? null : <>
      <section className="config-section" aria-label={labels.scheduleSection}>
        <p className="muted" title={schedule.asOf === undefined ? undefined : labels.asOf(formatTimestamp(schedule.asOf, language))}
          style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }}>
          {schedule.asOf === undefined ? "" : labels.asOf(formatTimestamp(schedule.asOf, language))}
        </p>
        <dl className="ads-schedule-summary" aria-label={labels.scheduleSection}>
          <div><dt>{labels.lastAd}</dt><dd>{schedule.schedule.lastAdAt === null ? labels.noValue : formatTimestamp(schedule.schedule.lastAdAt, language)}</dd></div>
          <div><dt>{labels.nextAd}</dt><dd>{schedule.schedule.nextAdAt === null ? labels.noAdBreak : formatTimestamp(schedule.schedule.nextAdAt, language)}</dd></div>
          <div><dt>{labels.dueIn}</dt><dd>{schedule.schedule.nextAdAt === null ? labels.noValue : formatDueIn(schedule.schedule.nextAdAt, language, effectiveNow)}</dd></div>
          <div><dt>{labels.prerollFree}</dt><dd>{schedule.schedule.prerollFreeTime === null ? labels.noValue : `${String(schedule.schedule.prerollFreeTime)} s`}</dd></div>
        </dl>
      </section>
      <section className="config-section" aria-label={labels.snoozeSection}>
        <div className="section-heading"><h2>{labels.snoozeSection}</h2></div>
        <span className="sr-only" id="ads-snooze-reason">{snoozeReason}</span>
        <Button variant="secondary" icon="ad" disabled={snoozeButtonDisabled} describedBy="ads-snooze-reason"
          {...(snoozeReason.length === 0 ? {} : { title: snoozeReason })} onClick={() => { void snooze(); }}>{snoozeLabel}</Button>
        <p className="lock-reason lock-reason--with-icon" data-testid="ads-snooze-result-slot"
          title={[snoozeReason, snoozeRefresh].filter(Boolean).join("\n") || undefined}
          style={{ height: "calc(var(--s10) * 2)", margin: 0, alignItems: "flex-start", flexWrap: "wrap" }} aria-live="polite">
          {canManage && snoozeReason.length > 0 ? <><Icon name="lock" size={16} />{snoozeReason}</> : snoozeResult === null ? null : <span role="alert" className="ads-snooze-result">{snoozeResult}</span>}
          {snoozeRefresh === null ? null : <span className="ads-snooze-refresh">{snoozeRefresh}</span>}
        </p>
      </section>
      <section className="config-section" aria-label={labels.recentSection}>
        <div className="section-heading"><h2>{labels.recentSection}</h2></div>
        <div className="ads-recent-list-slot" data-testid="ads-recent-list-slot">
          {schedule.recentAdBreaks.length === 0 ? <p className="empty-state">{labels.noRecent}</p> : (
          <div className="table-wrap ads-recent-list-slot__table">
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
