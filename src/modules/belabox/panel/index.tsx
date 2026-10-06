import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Field, InspectorActions, InspectorFieldRow, InspectorSection, notify } from "../../../dashboard/ui";
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
  const pollingInactive = status?.pollingDesired === true && !status.polling;

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await loadBelaboxStatus(channelId));
  }, [channelId]);

  useEffect(() => {
    let active = true;
    loadBelaboxStatus(channelId).then((next) => {
      if (active) setStatus(next);
    }).catch(() => {
      if (active) notify({ tone: "error", message: labels.testFailed });
    });
    return () => { active = false; };
  }, [channelId, labels.testFailed]);

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
        notify({ tone: "error", message: belaboxReasonText(labels, next.reason) });
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
    } catch (failure: unknown) {
      notify({ tone: "error", message: errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.testFailed });
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

  return <section className="module-stack" aria-label={labels.title}>
    {!canManage ? <p className="lock-reason">{labels.readOnly}</p> : null}
    <InspectorSection title={labels.connection}>
      <p className="muted">{status?.configured ? labels.configured : labels.notConfigured}</p>
      <div className="belabox-polling-retry-slot">
        {pollingInactive && canManage ? <Button disabled={busy} onClick={() => { void retryPolling(); }}>{labels.retryPolling}</Button> : null}
      </div>
      {status?.updatedAt === null || status?.updatedAt === undefined ? null : <p className="muted">{labels.updatedAt}: {statusTimestamp(status.updatedAt, language === "de" ? "de-DE" : "en-US")}</p>}
      {sampleSummary === null ? null : <p className="muted">{labels.latestSample}: {sampleSummary}</p>}
      <Button disabled={!canManage || busy} onClick={() => { void test(); }}>{labels.testConnection}</Button>
    </InspectorSection>
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
