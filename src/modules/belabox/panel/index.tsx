import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Field, InspectorActions, InspectorFieldRow, InspectorSection, LoadState, notify, Skeleton } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { BelaboxHistoryPoint, BelaboxStatusResponse, BelaboxStreamSummary } from "../contracts";
import { belaboxReasonText, belaboxPanelTexts } from "./locale";
import { BelaboxHistorySection } from "./history-chart";
import { loadBelaboxHistory, loadBelaboxStatus, loadBelaboxStreams, removeBelaboxStatsUrl, replaceBelaboxStatsUrl, retryBelaboxPolling, testBelaboxConnection } from "./service";

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

const statusTimestamp = (value: string, locale: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

export default function BelaboxPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const labels = belaboxPanelTexts(language);
  const [status, setStatus] = useState<BelaboxStatusResponse | null>(null);
  const [url, setUrl] = useState("");
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [testOutcome, setTestOutcome] = useState<string | null>(null);
  const [history, setHistory] = useState<BelaboxHistoryPoint[]>([]);
  const [streams, setStreams] = useState<BelaboxStreamSummary[]>([]);
  const [historyRange, setHistoryRange] = useState<"live" | "stream">("live");
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const pollingInactive = status?.pollingDesired === true && !status.polling;

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await loadBelaboxStatus(channelId));
  }, [channelId]);

  useEffect(() => {
    let active = true;
    loadBelaboxStatus(channelId).then((next) => {
      if (active) {
        setStatus(next);
        setLoadFailed(false);
      }
    }).catch(() => {
      if (active) {
        setLoadFailed(true);
        notify({ tone: "error", message: labels.testFailed });
      }
    });
    return () => { active = false; };
  }, [channelId, labels.testFailed]);

  useEffect(() => {
    if (pollingInactive) notify({ tone: "error", message: labels.pollingInactive });
  }, [labels.pollingInactive, pollingInactive]);

  useEffect(() => {
    if (status?.mode !== "interval") return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadBelaboxStreams(channelId);
        if (active) {
          setStreams(next);
          setSelectedStreamId((current) => {
            if (current !== null && next.some((stream) => stream.streamId === current)) return current;
            if (status.belaboxStreamId !== null && next.some((stream) => stream.streamId === status.belaboxStreamId)) {
              return status.belaboxStreamId;
            }
            return next[0]?.streamId ?? null;
          });
        }
      } catch {
        // Keep the last known list if a background refresh fails.
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [channelId, status?.belaboxStreamId, status?.mode]);

  useEffect(() => {
    if (status?.mode !== "interval") return;
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const streamId = historyRange === "stream" ? selectedStreamId ?? status.belaboxStreamId ?? undefined : undefined;
        const next = await loadBelaboxHistory(channelId, historyRange, streamId);
        if (active) setHistory(next);
      } catch {
        // Preserve existing points while the next scheduled refresh retries.
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [channelId, historyRange, selectedStreamId, status?.belaboxStreamId, status?.mode]);

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
    setStatus({
      configured: false,
      updatedAt: null,
      mode: status.mode,
      sample: null,
      errorCode: null,
      polling: false,
      pollingDesired: false,
      streamId: null,
      belaboxStreamId: null,
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
      selectedStreamId={selectedStreamId} range={historyRange}
      onRangeChange={setHistoryRange} onStreamSelect={setSelectedStreamId} onDemand={status?.mode === "on_demand"} />
  </section>;
}
