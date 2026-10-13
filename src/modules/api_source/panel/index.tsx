import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { apiSourceFailureText } from "../../../dashboard/locale";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, ConfirmDialog, Field, FormDialog, InspectorFieldRow, InspectorSection, LoadState, LoadStateLines, notify } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { ApiSource, ApiSourceTestResult } from "../contracts";
import { apiSourcePanelTexts } from "./locale";
import { ExpressionField } from "./ExpressionField";
import { createApiSource, deleteApiSource, loadApiSources, testApiSource, updateApiSource } from "./service";

interface SourceDraft {
  name: string;
  url: string;
  expression: string;
}

const emptyDraft = (): SourceDraft => ({ name: "", url: "", expression: "" });

const apiErrorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

const disallowedConstructName = (error: unknown): string | null => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || Array.isArray(error.details)) return null;
  const constructName = (error.details as { constructName?: unknown }).constructName;
  return typeof constructName === "string" ? constructName : null;
};

export default function ApiSourcePanel(properties: ModulePanelProperties): ReactElement {
  return <ApiSourcePanelContent key={properties.channelId} {...properties} />;
}

function ApiSourcePanelContent({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const labels = apiSourcePanelTexts(language ?? "de");
  const canEdit = canManage ?? false;
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "api_source", "sources", (signal) => loadApiSources(channelId, signal));
  const sources = query.data ?? [];
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [draftBaselineRevision, setDraftBaselineRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiSourceTestResult>();
  const [testRequestError, setTestRequestError] = useState<string>();
  const [formError, setFormError] = useState<string | undefined>();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const closeEditor = (): void => {
    setDraft(null);
    setEditingName(null);
    setDraftBaselineRevision(null);
    setFormError(undefined);
    setConfirmDeleteOpen(false);
    setDeleteError(undefined);
    setTestResult(undefined);
    setTestRequestError(undefined);
  };

  const startCreate = (): void => {
    setEditingName(null);
    setDraftBaselineRevision(null);
    setDraft(emptyDraft());
    setFormError(undefined);
    setTestResult(undefined);
    setTestRequestError(undefined);
  };

  const startEdit = (source: ApiSource): void => {
    setEditingName(source.name);
    setDraftBaselineRevision(source.revision);
    setDraft({ name: source.name, url: source.url, expression: source.expression });
    setFormError(undefined);
    setTestResult(undefined);
    setTestRequestError(undefined);
  };

  const testDraft = async (): Promise<void> => {
    if (draft === null || !canEdit || busy || testing) return;
    setTesting(true);
    setTestResult(undefined);
    setTestRequestError(undefined);
    try {
      setTestResult(await testApiSource(channelId, {
        url: draft.url.trim(),
        expression: draft.expression.trim(),
      }));
    } catch (failure: unknown) {
      setTestRequestError(apiErrorCode(failure) === "api_source_management_denied" ? labels.denied : labels.testRequestFailed);
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (draft === null || !canEdit || busy) return;
    const normalized = { ...draft, name: draft.name.trim(), url: draft.url.trim(), expression: draft.expression.trim() };
    setBusy(true);
    setFormError(undefined);
    try {
      if (editingName === null) {
        await runModuleQueryWrite(
          queryClient,
          channelId,
          "api_source",
          "sources",
          () => createApiSource(channelId, normalized),
          {
            baselineRevision: null,
            updateCache: (current, created) => updateSourceCache(current, created),
          },
        );
      }
      else {
        if (draftBaselineRevision === null) throw new Error("api_source_revision_missing");
        await runModuleQueryWrite(
          queryClient,
          channelId,
          "api_source",
          "sources",
          (baselineRevision) => updateApiSource(channelId, editingName, {
            url: normalized.url,
            expression: normalized.expression,
            revision: requireBaselineRevision(baselineRevision),
          }),
          {
            baselineRevision: draftBaselineRevision,
            updateCache: (current, updated) => updateSourceCache(current, updated),
          },
        );
      }
      closeEditor();
      notify({ tone: "success", message: editingName === null ? labels.created : labels.saved });
    } catch (failure: unknown) {
      const code = apiErrorCode(failure);
      const constructName = disallowedConstructName(failure);
      setFormError(code === "api_source_construct_not_allowed" && constructName !== null ? labels.constructNotAllowed(constructName)
        : code === "api_source_invalid" ? labels.invalid
        : code === "api_source_conflict" ? labels.conflict
          : code === "api_source_management_denied" ? labels.denied
            : code === "api_source_limit_or_conflict" ? labels.limit : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    const source = sources.find((candidate) => candidate.name === editingName);
    if (source === undefined || !canEdit || busy) return;
    setBusy(true);
    setDeleteError(undefined);
    try {
      if (draftBaselineRevision === null) throw new Error("api_source_revision_missing");
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "api_source",
        "sources",
        (baselineRevision) => deleteApiSource(channelId, source.name, requireBaselineRevision(baselineRevision)),
        {
          baselineRevision: draftBaselineRevision,
          updateCache: (current) => removeSourceFromCache(current, source.name),
        },
      );
      closeEditor();
      notify({ tone: "success", message: labels.deleted });
    } catch (failure: unknown) {
      const code = apiErrorCode(failure);
      setDeleteError(code === "api_source_in_use" ? labels.inUse
        : code === "api_source_management_denied" ? labels.denied : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const loadStatus = query.data === undefined ? query.isPending ? "loading" : "error" : sources.length === 0 ? "empty" : "success";

  return <section className="module-stack api-source-panel" aria-label={labels.title}>
    <p className="muted">{labels.explanation}</p>
    <InspectorSection title={labels.sourceList}>
      <div data-testid="api-source-list-slot" style={{ height: "calc(var(--s10) * 6)", overflow: "hidden" }}>
      <LoadState
        variant="panel-200"
        status={loadStatus}
        loading={<LoadStateLines rows={4} height={34} />}
        empty={<p className="muted">{labels.empty}</p>}
        error={<p className="muted">{labels.loadFailed}</p>}
        queryError={{ message: labels.loadFailed, onRetry: () => { void query.refetch(); } }}
        refreshError={query.isRefetchError}
      >
        <ul className="api-source-panel__list" style={{ height: "calc(var(--s10) * 5)", overflowY: "auto", margin: 0, padding: 0, listStyle: "none" }}>
          {sources.map((source) => {
            const failed = source.lastStatus === "error";
            const statusText = source.lastStatus === null
              ? labels.notTested
              : failed
                ? apiSourceFailureText(source.lastError ?? "unreachable", language ?? "de")
                : labels.statusOk;
            const status = source.lastStatus === null ? "off" : failed ? "error" : "ok";
            return <li key={source.name} style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", alignItems: "center", gap: "var(--s2)" }}>
              <Button size="compact" variant={editingName === source.name ? "secondary" : "neutral"} onClick={() => startEdit(source)}>
                <code>{source.name}</code>
              </Button>
              <span className="muted" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{new URL(source.url).hostname}</span>
              <span className="status-led" data-status={status} title={source.lastFetchedAt ?? undefined}>
                <span className="status-led__dot" aria-hidden="true" />
                <span className="status-led__label">{statusText}</span>
              </span>
            </li>;
          })}
        </ul>
      </LoadState>
      </div>
      <p className="lock-reason" data-testid="api-source-permission-slot" title={canEdit ? undefined : labels.readOnlyReason}
        style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
        {canEdit ? "" : labels.readOnlyReason}
      </p>
      <Button disabled={!canEdit || busy} onClick={startCreate}>{labels.addSource}</Button>
    </InspectorSection>

    <FormDialog
      opened={draft !== null}
      title={editingName === null ? labels.createSource : labels.editSource}
      confirmLabel={labels.save}
      cancelLabel={labels.cancel}
      {...(canEdit ? {} : { description: labels.readOnlyReason })}
      onConfirm={() => { void save(); }}
      onCancel={closeEditor}
      pending={busy || testing}
      confirmDisabled={!canEdit || draft === null || draft.name.trim().length === 0 || draft.url.trim().length === 0 || testing}
      {...(formError === undefined ? {} : { error: formError })}
    >
      {draft === null ? null : <div className="module-stack">
        <InspectorFieldRow label={labels.name} help={labels.nameHint}>
          <Field label={labels.name} value={draft.name} onChange={(name) => { setDraft({ ...draft, name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 32) }); setTestResult(undefined); }} disabled={busy || testing || !canEdit || editingName !== null} readOnly={editingName !== null} />
        </InspectorFieldRow>
        <InspectorFieldRow label={labels.url} help={labels.urlHint}>
          <Field label={labels.url} value={draft.url} onChange={(url) => { setDraft({ ...draft, url }); setTestResult(undefined); setTestRequestError(undefined); }} disabled={busy || testing || !canEdit} mono />
        </InspectorFieldRow>
        <InspectorFieldRow label={labels.expression} help={labels.expressionHint}>
          <ExpressionField id="api-source-expression" label={labels.expression} value={draft.expression} onChange={(expression) => { setDraft({ ...draft, expression }); setTestResult(undefined); setTestRequestError(undefined); }} maxLength={512} language={language ?? "de"} messages={labels.expressionPicker} disabled={busy || testing || !canEdit} />
        </InspectorFieldRow>
        <p className="muted" title={draft.expression.trim().length === 0 ? labels.noExpression : undefined}
          style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }} aria-live="polite">
          {draft.expression.trim().length === 0 ? labels.noExpression : ""}
        </p>
        <div className="form-actions">
          <Button type="button" disabled={!canEdit || busy || testing || draft.url.trim().length === 0} onClick={() => { void testDraft(); }}>
            {testing ? labels.testing : labels.test}
          </Button>
          {editingName === null ? null : <Button type="button" danger="subtle" disabled={!canEdit || busy || testing} onClick={() => { setDeleteError(undefined); setConfirmDeleteOpen(true); }}>{labels.delete}</Button>}
        </div>
        <div data-testid="api-source-test-result" aria-live="polite" style={{ height: "calc(var(--s10) * 5)", overflowY: "auto", boxSizing: "border-box", margin: 0 }}>
          {testRequestError === undefined ? null : <p role="alert">{testRequestError}</p>}
          {testResult?.status === "error" ? <p role="alert">
            {apiSourceFailureText(testResult.reason, language ?? "de", testResult.retryAfter)}
            {testResult.constructName === undefined ? "" : ` · ${testResult.constructName}`}
            {testResult.httpStatus === undefined ? "" : ` · HTTP ${String(testResult.httpStatus)}`}
          </p> : null}
          {testResult?.status === "ok" ? <>
            <p role="status">{labels.testSucceeded(testResult.httpStatus, testResult.bytes)}</p>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify({ json: testResult.json, value: testResult.value }, null, 2)}
            </pre>
          </> : null}
        </div>
      </div>}
    </FormDialog>

    <ConfirmDialog
      opened={confirmDeleteOpen}
      title={labels.deleteTitle}
      description={labels.deleteConsequence}
      confirmLabel={labels.delete}
      cancelLabel={labels.cancel}
      danger
      pending={busy}
      {...(deleteError === undefined ? {} : { error: deleteError })}
      onConfirm={() => { void remove(); }}
      onCancel={() => { setConfirmDeleteOpen(false); setDeleteError(undefined); }}
    />
  </section>;
}

const requireBaselineRevision = (revision: number | null): number => {
  if (revision === null) throw new Error("api_source_revision_missing");
  return revision;
};

const updateSourceCache = (current: unknown, source: ApiSource): unknown => {
  const sources = Array.isArray(current) ? current as ApiSource[] : [];
  return [...sources.filter((entry) => entry.name !== source.name), source];
};

const removeSourceFromCache = (current: unknown, name: string): unknown => {
  const sources = Array.isArray(current) ? current as ApiSource[] : [];
  return sources.filter((entry) => entry.name !== name);
};
