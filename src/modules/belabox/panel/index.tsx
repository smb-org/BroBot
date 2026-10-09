import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Field, InspectorActions, InspectorFieldRow, InspectorSection, LoadState, notify, Skeleton } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { BelaboxHistoryPoint, BelaboxStatusResponse, BelaboxStreamSummary } from "../contracts";
import { belaboxReasonText, belaboxPanelTexts } from "./locale";
import { BelaboxHistorySection } from "./history-chart";
import { loadBelaboxHistory, loadBelaboxStatus, loadBelaboxStreams, removeBelaboxStatsUrl, replaceBelaboxStatsUrl, retryBelaboxPolling, testBelaboxConnection } from "./service";
import { moduleQueryKey, refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;
const IDLE_STATUS_REFRESH_MS = 60_000;

const statusTimestamp = (value: string, locale: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

export default function BelaboxPanel({ channelId, language = "de", canManage = false, settingsRefreshToken = 0 }: ModulePanelProperties): ReactElement {
  const labels = belaboxPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const statusQuery = useModuleQuery(channelId, "belabox", "status", (signal) => loadBelaboxStatus(channelId, signal), {
    refetchInterval: realtimeStatus === "connected" ? false : (query) => {
      const current = query.state.data;
      return current?.pollingDesired === true
        ? Math.max(5, current.intervalSeconds) * 1_000
        : IDLE_STATUS_REFRESH_MS;
    },
  });
  const status = statusQuery.data ?? null;
  const [url, setUrl] = useState("");
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadFailed = statusQuery.isError;
  const [testOutcome, setTestOutcome] = useState<string | null>(null);
  const [historyRange, setHistoryRange] = useState<"live" | "stream">("live");
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const pollingInactive = status?.pollingDesired === true && !status.polling;
  const loadErrorNotified = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    await refetchModuleQueryData<BelaboxStatusResponse>(queryClient, channelId, "belabox", "status");
  }, [channelId, queryClient]);

  useEffect(() => {
    if (settingsRefreshToken === 0) return;
    void queryClient.invalidateQueries({ queryKey: moduleQueryKey(channelId, "belabox", "status"), exact: true });
  }, [channelId, queryClient, settingsRefreshToken]);

  useEffect(() => {
    if (statusQuery.data !== undefined) loadErrorNotified.current = false;
    if (!statusQuery.isError || loadErrorNotified.current) return;
    loadErrorNotified.current = true;
    notify({ tone: "error", message: labels.testFailed });
  }, [labels.testFailed, statusQuery.data, statusQuery.error, statusQuery.isError]);

  useEffect(() => {
    if (pollingInactive) notify({ tone: "error", message: labels.pollingInactive });
  }, [labels.pollingInactive, pollingInactive]);

  const streamsQuery = useModuleQuery(channelId, "belabox", "streams", (signal) => loadBelaboxStreams(channelId, signal), {
    enabled: status?.mode === "interval",
    refetchInterval: realtimeStatus === "connected" ? false : 60_000,
  });
  const streams: readonly BelaboxStreamSummary[] = streamsQuery.data ?? [];
  const currentStreamId = selectedStreamId !== null && streams.some((stream) => stream.streamId === selectedStreamId)
    ? selectedStreamId
    : status?.belaboxStreamId !== null && status?.belaboxStreamId !== undefined && streams.some((stream) => stream.streamId === status.belaboxStreamId)
      ? status.belaboxStreamId
      : streams[0]?.streamId ?? null;
  const streamId = historyRange === "stream" ? currentStreamId ?? undefined : undefined;
  const historyPart = historyRange === "live" ? "history-live" : `history-stream-${streamId ?? "latest"}`;
  const historyQuery = useModuleQuery(channelId, "belabox", historyPart,
    (signal) => loadBelaboxHistory(channelId, historyRange, streamId, signal), {
      enabled: status?.mode === "interval",
      refetchInterval: realtimeStatus === "connected" ? false : 15_000,
    });
  const history: readonly BelaboxHistoryPoint[] = historyQuery.data ?? [];

  const save = async (): Promise<void> => {
    if (!canManage || busy || url.length === 0) return;
    setBusy(true);
    try {
      await replaceBelaboxStatsUrl(channelId, url);
      setUrl("");
      await refresh();
      notify({ tone: "success", message: labels.saved });
    } catch (failure: unknown) {
      notify({ tone: "error", message: errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      const next = await testBelaboxConnection(channelId, url.length === 0 ? undefined : url);
      if (!next.ok) {
        const reason = belaboxReasonText(labels, next.reason);
        setTestOutcome(reason);
        notify({ tone: "error", message: reason });
        return;
      }
      if (url.length === 0) {
        try {
          await refresh();
        } catch {
          notify({ tone: "error", message: labels.refreshFailed });
          return;
        }
      }
      notify({
        tone: next.connected ? "success" : "info",
        message: `${next.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(next.bitrateKbps)} kbps`,
      });
      setTestOutcome(`${next.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(next.bitrateKbps)} kbps`);
    } catch (failure: unknown) {
      const message = errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.testFailed;
      setTestOutcome(message);
      notify({ tone: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const retryPolling = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      await retryBelaboxPolling(channelId);
      await refresh();
    } catch (failure: unknown) {
      notify({ tone: "error", message: errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.retryPollingFailed });
    } finally {
      setBusy(false);
    }
  };

  const checkNow = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    try {
      const result = await testBelaboxConnection(channelId);
      if (!result.ok) {
        const message = belaboxReasonText(labels, result.reason);
        setTestOutcome(message);
        notify({ tone: "error", message });
        return;
      }
      await refresh();
      const message = `${result.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(result.bitrateKbps)} kbps`;
      setTestOutcome(message);
      notify({ tone: result.connected ? "success" : "info", message });
    } catch {
      notify({ tone: "error", message: labels.testFailed });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!canManage || busy || status?.configured !== true) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await removeBelaboxStatsUrl(channelId);
    } catch (failure: unknown) {
      setRemoveError(errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.removeFailed);
      setBusy(false);
      return;
    }
    // The delete succeeded: reflect it locally, independent of the refresh below.
    queryClient.setQueryData<BelaboxStatusResponse>(moduleQueryKey(channelId, "belabox", "status"), {
      configured: false,
      updatedAt: null,
      mode: status.mode,
      sample: null,
      errorCode: null,
      polling: false,
      pollingDesired: false,
      streamId: null,
      belaboxStreamId: null,
      alertNotice: null,
      fetchFailureNotice: false,
      intervalSeconds: 15,
    });
    setRemoveConfirmOpen(false);
    try {
      await refresh();
      notify({ tone: "success", message: labels.removed });
    } catch {
      notify({ tone: "error", message: labels.refreshFailed });
    } finally {
      setBusy(false);
    }
  };

  const sampleSummary = status?.sample === null || status?.sample === undefined
    ? null
    : `${status.sample.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(status.sample.bitrateKbps)} kbps`;
  const connectionStatus = status === null ? loadFailed ? "error" : "loading" : "success";
  const alertNoticeText = status?.alertNotice === null || status?.alertNotice === undefined
    ? null
    : `${status.alertNotice.phase === "pending" ? labels.alertPending : status.alertNotice.phase === "recovering"
      ? labels.alertRecovering : status.alertNotice.kind === "disconnect" ? labels.alertDisconnect : labels.alertLow}${
      status.alertNotice.bitrateKbps === null ? "" : ` · ${labels.bitrate}: ${String(status.alertNotice.bitrateKbps)} kbps`}`;
  const noticeText = status?.fetchFailureNotice === true ? labels.fetchFailureNotice : alertNoticeText;

  return <section className="module-stack" aria-label={labels.title}>
    <InspectorSection title={labels.connection}>
      <LoadState status={connectionStatus} minHeight="calc(var(--s10) * 8)"
        loading={<Skeleton rows={5} height={34} />}
        empty={<p className="muted">{labels.notConfigured}</p>}
        error={<p className="muted">{labels.refreshFailed}</p>}>
        <p className="muted">{status?.configured ? labels.configured : labels.notConfigured}</p>
        <div className="belabox-polling-retry-slot">
          {pollingInactive && canManage ? <Button disabled={busy} onClick={() => { void retryPolling(); }}>{labels.retryPolling}</Button> : null}
        </div>
        <p className="muted" data-testid="belabox-updated-at-slot" title={status?.updatedAt == null ? undefined : `${labels.updatedAt}: ${statusTimestamp(status.updatedAt, language === "de" ? "de-DE" : "en-US")}`}
          style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflowWrap: "anywhere" }}>
          {status?.updatedAt == null ? "" : `${labels.updatedAt}: ${statusTimestamp(status.updatedAt, language === "de" ? "de-DE" : "en-US")}`}
        </p>
        <p className="muted" data-testid="belabox-sample-slot" title={sampleSummary === null ? undefined : `${labels.latestSample}: ${sampleSummary}`}
          style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflowWrap: "anywhere" }}>
          {sampleSummary === null ? "" : `${labels.latestSample}: ${sampleSummary}`}
        </p>
        <div className="belabox-alert-notice-slot" role="status" aria-live="polite" data-testid="belabox-alert-notice-slot"
          style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s2)" }}>
          <span className={noticeText === null ? "muted" : ""} title={noticeText ?? undefined}
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{noticeText ?? ""}</span>
          {noticeText !== null && status?.configured === true && canManage
            ? <Button disabled={busy} onClick={() => { void checkNow(); }}>{labels.checkNow}</Button>
            : null}
        </div>
        <Button disabled={!canManage || busy || status === null} onClick={() => { void test(); }}>{labels.testConnection}</Button>
        <p className="muted" data-testid="belabox-test-result-slot" role="status" aria-live="polite" title={testOutcome ?? undefined}
          style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflowWrap: "anywhere" }}>{testOutcome ?? ""}</p>
      </LoadState>
    </InspectorSection>
    <p className="lock-reason" title={canManage ? undefined : labels.readOnly}
      style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
      {canManage ? "" : labels.readOnly}
    </p>
    <InspectorSection title={labels.replace}>
      <InspectorFieldRow label={labels.statsUrl}>
        <Field
          id="belabox-stats-url"
          label={labels.statsUrl}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={url}
          onChange={setUrl}
          disabled={!canManage || busy}
        />
      </InspectorFieldRow>
      <div className="form-actions">
        <Button variant="primary" disabled={!canManage || busy || url.length === 0} onClick={() => { void save(); }}>{labels.save}</Button>
      </div>
    </InspectorSection>
    <InspectorActions destructive={<Button danger="subtle" disabled={!canManage || busy || status?.configured !== true}
      onClick={() => { setRemoveError(null); setRemoveConfirmOpen(true); }}>{labels.remove}</Button>} />
    <ConfirmDialog opened={removeConfirmOpen} title={labels.removeTitle} description={labels.removeConsequence}
      confirmLabel={labels.confirmRemove} cancelLabel={labels.cancel} onCancel={() => { setRemoveConfirmOpen(false); setRemoveError(null); }}
      onConfirm={() => { void remove(); }} pending={busy} danger {...(removeError === null ? {} : { error: removeError })} />
    <BelaboxHistorySection labels={labels} locale={language === "de" ? "de-DE" : "en-US"}
      points={status?.mode === "interval" ? history : []} streams={status?.mode === "interval" ? streams : []}
      selectedStreamId={currentStreamId} range={historyRange}
      onRangeChange={setHistoryRange} onStreamSelect={setSelectedStreamId} onDemand={status?.mode === "on_demand"} />
  </section>;
}
