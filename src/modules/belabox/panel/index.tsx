import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, ConfirmDialog, Field, InspectorActions, InspectorFieldRow, InspectorSection } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { BelaboxStatusResponse, BelaboxTestResult } from "../contracts";
import { belaboxReasonText, belaboxPanelTexts } from "./locale";
import { loadBelaboxStatus, removeBelaboxStatsUrl, replaceBelaboxStatsUrl, testBelaboxConnection } from "./service";

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

const statusTimestamp = (value: string, locale: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

export default function BelaboxPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const labels = belaboxPanelTexts(language);
  const [status, setStatus] = useState<BelaboxStatusResponse | null>(null);
  const [url, setUrl] = useState("");
  const [testResult, setTestResult] = useState<BelaboxTestResult | null>(null);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setStatus(await loadBelaboxStatus(channelId));
  }, [channelId]);

  useEffect(() => {
    let active = true;
    loadBelaboxStatus(channelId).then((next) => {
      if (active) {
        setStatus(next);
        setError("");
      }
    }).catch(() => {
      if (active) setError(labels.testFailed);
    });
    return () => { active = false; };
  }, [channelId, labels.testFailed]);

  const save = async (): Promise<void> => {
    if (!canManage || busy || url.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await replaceBelaboxStatsUrl(channelId, url);
      setUrl("");
      setTestResult(null);
      await refresh();
      setNotice(labels.saved);
    } catch (failure: unknown) {
      setError(errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await testBelaboxConnection(channelId, url.length === 0 ? undefined : url);
      setTestResult(next);
      if (next.ok && url.length === 0) await refresh();
    } catch (failure: unknown) {
      setError(errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.testFailed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!canManage || busy || status?.configured !== true) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await removeBelaboxStatsUrl(channelId);
      setRemoveConfirmOpen(false);
      setTestResult(null);
      await refresh();
      setNotice(labels.removed);
    } catch (failure: unknown) {
      setError(errorCode(failure) === "belabox_management_denied" ? labels.readOnly : labels.removeFailed);
    } finally {
      setBusy(false);
    }
  };

  const testError = testResult !== null && !testResult.ok ? belaboxReasonText(labels, testResult.reason) : "";
  const testSummary = testResult?.ok === true
    ? `${testResult.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(testResult.bitrateKbps)} kbps`
    : "";
  const sampleSummary = status?.sample === null || status?.sample === undefined
    ? null
    : `${status.sample.connected ? labels.connected : labels.disconnected} · ${labels.bitrate}: ${String(status.sample.bitrateKbps)} kbps`;

  return <section className="module-stack" aria-label={labels.title}>
    {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
    {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
    {!canManage ? <p className="lock-reason">{labels.readOnly}</p> : null}
    <InspectorSection title={labels.connection}>
      <p className="muted">{status?.configured ? labels.configured : labels.notConfigured}</p>
      {status?.updatedAt === null || status?.updatedAt === undefined ? null : <p className="muted">{labels.updatedAt}: {statusTimestamp(status.updatedAt, language === "de" ? "de-DE" : "en-US")}</p>}
      {sampleSummary === null ? null : <p className="muted">{labels.latestSample}: {sampleSummary}</p>}
      <Button disabled={!canManage || busy} onClick={() => { void test(); }}>{labels.testConnection}</Button>
      {testError.length > 0 ? <p className="form-error" role="alert">{testError}</p> : null}
      {testSummary.length > 0 ? <p className="muted" role="status">{testSummary}</p> : null}
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
          onChange={(value) => { setUrl(value); setTestResult(null); }}
          disabled={!canManage || busy}
        />
      </InspectorFieldRow>
      <div className="form-actions">
        <Button variant="primary" disabled={!canManage || busy || url.length === 0} onClick={() => { void save(); }}>{labels.save}</Button>
      </div>
    </InspectorSection>
    <InspectorActions destructive={<Button danger="subtle" disabled={!canManage || busy || status?.configured !== true}
      onClick={() => { setRemoveConfirmOpen(true); }}>{labels.remove}</Button>} />
    <ConfirmDialog opened={removeConfirmOpen} title={labels.removeTitle} description={labels.removeConsequence}
      confirmLabel={labels.confirmRemove} cancelLabel={labels.cancel} onCancel={() => { setRemoveConfirmOpen(false); }}
      onConfirm={() => { void remove(); }} pending={busy} danger />
  </section>;
}
