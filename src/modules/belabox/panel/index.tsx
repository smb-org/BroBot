import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Field, InspectorActions, InspectorFieldRow, InspectorSection, LoadState, notify, Skeleton } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { BelaboxStatusResponse } from "../contracts";
import { belaboxReasonText, belaboxPanelTexts } from "./locale";
import { loadBelaboxStatus, removeBelaboxStatsUrl, replaceBelaboxStatsUrl, retryBelaboxPolling, testBelaboxConnection } from "./service";

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
  const pollingInactive = status?.pollingDesired === true && !status.polling;
  const pollingIntervalSeconds = status?.pollingDesired === true ? status.intervalSeconds : null;

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
    if (pollingIntervalSeconds === null) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, Math.max(5, pollingIntervalSeconds) * 1_000);
    return () => window.clearInterval(timer);
  }, [pollingIntervalSeconds, refresh]);

  useEffect(() => {
    if (pollingInactive) notify({ tone: "error", message: labels.pollingInactive });
  }, [labels.pollingInactive, pollingInactive]);

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
    setStatus({
      configured: false,
      updatedAt: null,
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
  </section>;
}
