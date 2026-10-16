import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { ActionMenu, Button, ConfirmDialog, Field, InspectorSection, LoadState, LoadStateLines, StatusLed, notify, type StatusLedState } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { BelaboxSettings } from "../contracts";
import type { BelaboxHistoryPoint, BelaboxStatusResponse, BelaboxStreamSummary } from "../contracts";
import { belaboxReasonText, belaboxPanelTexts } from "./locale";
import { BelaboxHistorySection } from "./history-chart";
import { loadBelaboxHistory, loadBelaboxStatus, loadBelaboxStreams, removeBelaboxStatsUrl, retryBelaboxPolling, testBelaboxConnection } from "./service";
import { moduleQueryKey, refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

interface BelaboxPanelProperties extends ModulePanelProperties {
  lowBitrateKbps?: BelaboxSettings["lowBitrateKbps"];
  recoverBitrateKbps?: BelaboxSettings["recoverBitrateKbps"];
  statsUrlDraft?: string;
  onStatsUrlDraftChange?: (value: string) => void;
  savingSettings?: boolean;
}

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;
const IDLE_STATUS_REFRESH_MS = 60_000;

const statusTimestamp = (value: string, locale: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

const sampleIsStale = (status: BelaboxStatusResponse | null, now: number): boolean => {
  if (status === null) return false;
  if (status.errorCode != null) return true;
  if (status.sample == null) return false;
  const sampledAt = Date.parse(status.sample.at);
  return !Number.isFinite(sampledAt) ||
    now - sampledAt > Math.max(60_000, status.intervalSeconds * 3_000);
};

export default function BelaboxPanel({ channelId, language = "de", canManage = false, lowBitrateKbps: draftLowBitrateKbps,
  recoverBitrateKbps: draftRecoverBitrateKbps, statsUrlDraft = "", onStatsUrlDraftChange,
  savingSettings = false }: BelaboxPanelProperties): ReactElement {
  const labels = belaboxPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const loadErrorNotified = useRef(false);
  const suppressLoadErrorNotification = useRef(false);
  const readStatus = useCallback(async (signal: AbortSignal): Promise<BelaboxStatusResponse> => {
    try {
      const response = await loadBelaboxStatus(channelId, signal);
      loadErrorNotified.current = false;
      return response;
    } catch (failure: unknown) {
      if (!signal.aborted && !suppressLoadErrorNotification.current && !loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: labels.testFailed });
      }
      throw failure;
    }
  }, [channelId, labels.testFailed]);
  const statusQuery = useModuleQuery(channelId, "belabox", "status", readStatus, {
    refetchInterval: realtimeStatus === "connected" ? false : (query) => {
      const current = query.state.data;
      return current?.pollingDesired === true
        ? Math.max(5, current.intervalSeconds) * 1_000
        : IDLE_STATUS_REFRESH_MS;
    },
  });
  const status = statusQuery.data ?? null;
  const [now, setNow] = useState(() => Date.now());
  const staleSample = sampleIsStale(status, now);
  const lowBitrateKbps = draftLowBitrateKbps ?? 1_000;
  const recoverBitrateKbps = draftRecoverBitrateKbps ?? 2_000;
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadFailed = statusQuery.isError;
  const [testOutcome, setTestOutcome] = useState<string | null>(null);
  const [historyRange, setHistoryRange] = useState<"live" | "stream">("live");
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const pollingInactive = status?.pollingDesired === true && !status.polling;
  const sampleTimestamp = status?.sample?.at;

  useEffect(() => {
    if (sampleTimestamp === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [sampleTimestamp]);

  const refresh = useCallback(async (): Promise<void> => {
    suppressLoadErrorNotification.current = true;
    try {
      await refetchModuleQueryData<BelaboxStatusResponse>(queryClient, channelId, "belabox", "status");
    } catch (failure: unknown) {
      loadErrorNotified.current = true;
      throw failure;
    } finally {
      suppressLoadErrorNotification.current = false;
    }
  }, [channelId, queryClient]);

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

  const test = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await testBelaboxConnection(channelId, statsUrlDraft.length === 0 ? undefined : statsUrlDraft);
      if (!next.ok) {
        const reason = belaboxReasonText(labels, next.reason);
        setTestOutcome(reason);
        notify({ tone: "error", message: reason });
        return;
      }
      if (statsUrlDraft.length === 0) {
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
    ? "—"
    : `${status.sample.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(status.sample.bitrateKbps)} kbps`;
  const connectionStatus = status === null ? loadFailed ? "error" : "loading" : "success";
  const alertNoticeText = status?.alertNotice === null || status?.alertNotice === undefined
    ? null
    : `${status.alertNotice.phase === "pending" ? labels.alertPending : status.alertNotice.phase === "recovering"
      ? labels.alertRecovering : status.alertNotice.kind === "disconnect" ? labels.alertDisconnect : labels.alertLow}${
      status.alertNotice.bitrateKbps === null ? "" : ` · ${labels.bitrate}: ${String(status.alertNotice.bitrateKbps)} kbps`}`;
  const noticeText = status?.fetchFailureNotice === true ? labels.fetchFailureNotice : alertNoticeText;
  const connectionState: StatusLedState = status === null
    ? loadFailed ? "error" : "loading"
    : !status.configured
      ? "off"
      : staleSample
        ? "error"
        : status.sample === null
          ? "warn"
          : status.sample.connected ? "ok" : "error";
  const connectionLabel = status === null
    ? loadFailed ? labels.statusUnavailable : labels.loading
    : !status.configured
      ? labels.notConfigured
      : staleSample
        ? labels.stale
        : status.sample === null
          ? labels.awaitingSample
          : status.sample.connected ? labels.connected : labels.disconnected;
  const statusLocale = language === "de" ? "de-DE" : "en-US";
  const updatedAt = status?.updatedAt === null || status?.updatedAt === undefined ? "—" : statusTimestamp(status.updatedAt, statusLocale);
  const latestSampleAt = status?.sample === null || status?.sample === undefined ? "—" : statusTimestamp(status.sample.at, statusLocale);
  const readOnlyUrlState = status?.configured === true ? labels.statsUrlConfigured : labels.statsUrlNotConfigured;
  const menuItems = [{
    label: labels.remove,
    danger: true,
    disabled: !canManage || busy || status?.configured !== true,
    ...(!canManage ? { description: labels.readOnly } : {}),
    onSelect: () => { setRemoveError(null); setRemoveConfirmOpen(true); },
  }] as const;

  return <section className="module-stack belabox-panel" aria-label={labels.title}>
    <div className="belabox-overview">
      <InspectorSection title={labels.connection}>
        <LoadState variant="panel-0" status={connectionStatus}
          loading={<LoadStateLines rows={2} height={28} />}
          empty={<p className="muted">{labels.notConfigured}</p>}
          error={<p className="muted">{labels.refreshFailed}</p>}>
          <div className="belabox-connection-state"><StatusLed state={connectionState} label={connectionLabel} /></div>
          <dl className="properties belabox-connection-properties">
            <div><dt>{labels.updatedAt}</dt><dd>{updatedAt}</dd></div>
            <div><dt>{labels.latestSample}</dt><dd>{latestSampleAt} · {sampleSummary}</dd></div>
            {!canManage ? <div><dt>{labels.statsUrl}</dt><dd>{readOnlyUrlState}</dd></div> : null}
          </dl>
          {canManage && onStatsUrlDraftChange !== undefined ? <Field
            className="belabox-url-field"
            id="belabox-stats-url"
            label={labels.statsUrl}
            hint={labels.statsUrlHint}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={statsUrlDraft}
            onChange={onStatsUrlDraftChange}
            disabled={savingSettings}
          /> : null}
          <div className="belabox-alert-notice-slot" role="status" aria-live="polite" data-testid="belabox-alert-notice-slot">
            <span className={noticeText === null ? "muted" : ""} title={noticeText ?? undefined}>{noticeText ?? ""}</span>
            {noticeText !== null && status?.configured === true && canManage
              ? <Button disabled={busy} onClick={() => { void checkNow(); }}>{labels.checkNow}</Button>
              : null}
          </div>
          <div className="belabox-connection-actions">
            {pollingInactive && canManage ? <Button disabled={busy} onClick={() => { void retryPolling(); }}>{labels.retryPolling}</Button> : null}
            <Button disabled={busy || status === null} onClick={() => { void test(); }}>{labels.testConnection}</Button>
            <ActionMenu label={labels.connectionActions} items={menuItems} />
          </div>
          <p className="belabox-test-result muted" data-testid="belabox-test-result-slot" role="status" aria-live="polite" title={testOutcome ?? undefined}>{testOutcome ?? ""}</p>
        </LoadState>
      </InspectorSection>
      <BelaboxHistorySection labels={labels} locale={statusLocale}
        points={status?.mode === "interval" ? history : []} streams={status?.mode === "interval" ? streams : []}
        lowBitrateKbps={lowBitrateKbps} recoverBitrateKbps={recoverBitrateKbps}
        selectedStreamId={currentStreamId} range={historyRange}
        onRangeChange={setHistoryRange} onStreamSelect={setSelectedStreamId} onDemand={status?.mode === "on_demand"} />
    </div>
    <ConfirmDialog opened={removeConfirmOpen} title={labels.removeTitle} description={labels.removeConsequence}
      confirmLabel={labels.confirmRemove} cancelLabel={labels.cancel} onCancel={() => { setRemoveConfirmOpen(false); setRemoveError(null); }}
      onConfirm={() => { void remove(); }} pending={busy} danger {...(removeError === null ? {} : { error: removeError })} />
  </section>;
}
