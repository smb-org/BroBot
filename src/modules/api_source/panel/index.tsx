import "./panel.css";

import { useEffect, useState, type KeyboardEvent, type ReactElement, type SyntheticEvent } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { apiSourceFailureText, dashboardTexts, formatTimestamp } from "../../../dashboard/locale";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Badge,
  Button,
  CollectionPage,
  ConfirmDialog,
  Field,
  FormDialog,
  InspectorFieldRow,
  InspectorSection,
  LoadState,
  LoadStateLines,
  LockedReason,
  ListToolbar,
  PageHeader,
  StepDialog,
  TokenChip,
  notify,
  registerDashboardNavigationGuard,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { ApiSource, ApiSourceTestResult } from "../contracts";
import { apiSourcePanelTexts } from "./locale";
import { ExpressionField } from "./ExpressionField";
import { JsonResponseTree } from "./JsonResponseTree";
import { createApiSource, deleteApiSource, loadApiSources, testApiSource, updateApiSource } from "./service";

interface SourceDraft {
  name: string;
  url: string;
  expression: string;
}

const emptyDraft = (): SourceDraft => ({ name: "", url: "", expression: "" });
const sameDraft = (left: SourceDraft, right: SourceDraft): boolean =>
  left.name === right.name && left.url === right.url && left.expression === right.expression;

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
  const locale = language ?? "de";
  const labels = apiSourcePanelTexts(locale);
  const dashboard = dashboardTexts();
  const canEdit = canManage ?? false;
  const queryClient = useDashboardQueryClient();
  const query = useModuleQuery(channelId, "api_source", "sources", (signal) => loadApiSources(channelId, signal));
  const sources = query.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [draftOriginal, setDraftOriginal] = useState<SourceDraft | null>(null);
  const [draftBaselineRevision, setDraftBaselineRevision] = useState<number | null>(null);
  const [creationStep, setCreationStep] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiSourceTestResult>();
  const [testedInput, setTestedInput] = useState<{ url: string; expression: string }>();
  const [testRequestError, setTestRequestError] = useState<string>();
  const [formError, setFormError] = useState<string | undefined>();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const selectedSource = selectedName === null ? undefined : sources.find((source) => source.name === selectedName);
  const editorReadOnlyReasonId = `api-source-editor-read-only-${channelId}`;

  const sourceDraftDirty = draft !== null && draftOriginal !== null && !sameDraft(draft, draftOriginal);
  const discardEditor = (): void => {
    setDraft(null);
    setDraftOriginal(null);
    setEditingName(null);
    setDraftBaselineRevision(null);
    setCreationStep(0);
    setFormError(undefined);
    setConfirmDeleteOpen(false);
    setDeleteError(undefined);
    setTestResult(undefined);
    setTestedInput(undefined);
    setTestRequestError(undefined);
  };

  const editorGuard = useDraftGuard(sourceDraftDirty, () => Promise.resolve(labels.saveFailed), discardEditor);
  useEffect(() => registerDashboardNavigationGuard(editorGuard.guardSwitch), [editorGuard.guardSwitch]);

  const requestCloseEditor = (): void => { editorGuard.guardSwitch(discardEditor); };

  const startCreate = (): void => {
    setSelectedName(null);
    setEditingName(null);
    setDraftBaselineRevision(null);
    const initialDraft = emptyDraft();
    setDraft(initialDraft);
    setDraftOriginal(initialDraft);
    setCreationStep(0);
    setFormError(undefined);
    setTestResult(undefined);
    setTestedInput(undefined);
    setTestRequestError(undefined);
  };

  const startEdit = (source: ApiSource): void => {
    setSelectedName(source.name);
    setEditingName(source.name);
    setDraftBaselineRevision(source.revision);
    const initialDraft = { name: source.name, url: source.url, expression: source.expression };
    setDraft(initialDraft);
    setDraftOriginal(initialDraft);
    setFormError(undefined);
    setTestResult(undefined);
    setTestedInput(undefined);
    setTestRequestError(undefined);
  };

  const updateDraft = (patch: Partial<SourceDraft>): void => {
    if (draft === null) return;
    setDraft({ ...draft, ...patch });
    // A successful test stays valid for expression edits only; any other tested input invalidates it.
    const keepsTestedUrl = patch.url === undefined || patch.url.trim() === testedInput?.url;
    if (testResult?.status !== "ok" || !keepsTestedUrl) {
      setTestResult(undefined);
      setTestedInput(undefined);
    }
    setTestRequestError(undefined);
  };

  const testDraft = async (): Promise<void> => {
    if (draft === null || !canEdit || busy || testing) return;
    const input = { url: draft.url.trim(), expression: draft.expression.trim() };
    setTesting(true);
    setTestResult(undefined);
    setTestedInput(undefined);
    setTestRequestError(undefined);
    try {
      const result = await testApiSource(channelId, input);
      setTestResult(result);
      if (result.status === "ok") setTestedInput(input);
    } catch (failure: unknown) {
      setTestRequestError(apiErrorCode(failure) === "api_source_management_denied" ? labels.denied : labels.testRequestFailed);
    } finally {
      setTesting(false);
    }
  };

  const testResultIsStale = testResult?.status === "ok" && testedInput !== undefined && draft !== null &&
    (testedInput.url !== draft.url.trim() || testedInput.expression !== draft.expression.trim());
  const testResultDisplay = <div data-testid="api-source-test-result" className="api-source-panel__test-result">
    <div className="api-source-panel__test-result-status" aria-live="polite">
      {testing ? <p role="status">{labels.testing}</p> : null}
      {testRequestError === undefined ? null : <p className="api-source-test-result__error" role="alert">{testRequestError}</p>}
      {testResult?.status === "error" ? <p className="api-source-test-result__error" role="alert">
        {apiSourceFailureText(testResult.reason, locale, testResult.retryAfter)}
        {testResult.constructName === undefined ? "" : ` · ${testResult.constructName}`}
        {testResult.httpStatus === undefined ? "" : ` · HTTP ${String(testResult.httpStatus)}`}
      </p> : null}
      {testResult?.status === "ok" ? <p role="status">{labels.testSucceeded(testResult.httpStatus, testResult.bytes)}</p> : null}
    </div>
    <JsonResponseTree
      value={testResult?.status === "ok" ? testResult.json : undefined}
      expression={draft?.expression ?? ""}
      loading={testing}
      messages={labels.responseTree}
      onSelectPath={(expression) => { updateDraft({ expression }); }}
    />
    <div className="api-source-panel__test-result-value" aria-live="polite">
      {testResult?.status === "ok" ? <p>
        <span>{labels.resultValue}</span>
        <code className={`mono${testResultIsStale ? " api-source-panel__test-result-value-stale" : ""}`} title={testResult.value}>{testResult.value}</code>
        {testResultIsStale ? <span role="status">{labels.resultStale}</span> : null}
      </p> : null}
    </div>
  </div>;

  const save = async (): Promise<string | null> => {
    if (draft === null || !canEdit || busy || (editingName === null && (creationStep !== 3 || draft.name.trim().length === 0))) return labels.saveFailed;
    const normalized = { ...draft, name: draft.name.trim(), url: draft.url.trim(), expression: draft.expression.trim() };
    setBusy(true);
    setFormError(undefined);
    try {
      if (editingName === null) {
        const created = await runModuleQueryWrite(
          queryClient,
          channelId,
          "api_source",
          "sources",
          () => createApiSource(channelId, normalized),
          {
            baselineRevision: null,
            updateCache: (current, source) => updateSourceCache(current, source),
          },
        );
        setSelectedName(created.name);
      } else {
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
      discardEditor();
      notify({ tone: "success", message: editingName === null ? labels.created : labels.saved });
      return null;
    } catch (failure: unknown) {
      const code = apiErrorCode(failure);
      const constructName = disallowedConstructName(failure);
      const errorText = code === "api_source_construct_not_allowed" && constructName !== null ? labels.constructNotAllowed(constructName)
        : code === "api_source_invalid" ? labels.invalid
        : code === "api_source_conflict" ? labels.conflict
          : code === "api_source_management_denied" ? labels.denied
            : code === "api_source_limit_or_conflict" ? labels.limit : labels.saveFailed;
      setFormError(errorText);
      return errorText;
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
      setSelectedName(null);
      discardEditor();
      notify({ tone: "success", message: labels.deleted });
    } catch (failure: unknown) {
      const code = apiErrorCode(failure);
      setDeleteError(code === "api_source_in_use" ? labels.inUse
        : code === "api_source_management_denied" ? labels.denied : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const testAttempted = testResult !== undefined || testRequestError !== undefined;
  const submitCreationStep = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (draft === null || !canEdit || busy || testing) return;
    if (creationStep === 0) {
      if (draft.url.trim().length > 0) setCreationStep(1);
      return;
    }
    if (creationStep === 1) {
      setCreationStep(2);
      return;
    }
    if (creationStep === 2) {
      if (testAttempted) setCreationStep(3);
      else void testDraft();
      return;
    }
    if (draft.name.trim().length === 0) return;
    void save();
  };
  const submitWizardOnShortcut = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey) || event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  };
  const loadStatus = query.data === undefined ? query.isPending ? "loading" : "error" : sources.length === 0 ? "empty" : "success";
  const statusFor = (source: ApiSource): { label: string; tone: "neutral" | "green" | "red" } => {
    if (source.lastStatus === null) return { label: labels.statusUntested, tone: "neutral" };
    if (source.lastStatus === "error") return { label: labels.statusError, tone: "red" };
    return { label: labels.statusOk, tone: "green" };
  };
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase(locale);
  const visibleSources = sources.filter((source) => normalizedSearch.length === 0 || source.name.toLocaleLowerCase(locale).includes(normalizedSearch) ||
    source.url.toLocaleLowerCase(locale).includes(normalizedSearch));
  const list = <LoadState
    variant="panel-0"
    status={loadStatus}
    loading={<LoadStateLines rows={4} height={54} />}
    empty={<p className="muted">{labels.empty}</p>}
    error={<p className="muted">{labels.loadFailed}</p>}
    queryError={{ message: labels.loadFailed, onRetry: () => { void query.refetch(); } }}
    refreshError={query.isRefetchError}
  >
    {sources.length === 0 ? null : visibleSources.length === 0 ? <p className="api-source-panel__empty muted">{labels.noSearchResults}</p> : <ul className="api-source-panel__list">
      {visibleSources.map((source) => {
        const status = statusFor(source);
        return <li className="api-source-panel__row" key={source.name}>
          <Button
            className="api-source-panel__select"
            variant={selectedName === source.name ? "secondary" : "subtle"}
            ariaLabel={`${source.name}, ${status.label}`}
            ariaPressed={selectedName === source.name}
            onClick={() => { setSelectedName(source.name); }}
          >
            <span className="api-source-panel__source-copy">
              <strong className="mono">{source.name}</strong>
              <span className="muted api-source-panel__host">{new URL(source.url).hostname}</span>
            </span>
            <span className="api-source-panel__row-status"><Badge tone={status.tone}>{status.label}</Badge></span>
          </Button>
        </li>;
      })}
    </ul>}
  </LoadState>;

  const detail = selectedSource === undefined ? <p className="muted">{labels.selectSource}</p> : <>
    <PageHeader
      title={selectedSource.name}
      titleContent={<span className="mono">{selectedSource.name}</span>}
      icon={null}
      headingLevel="h2"
      meta={new URL(selectedSource.url).hostname}
      actions={<TokenChip token={`{api.${selectedSource.name}}`} />}
      pageActions={<Button size="compact" disabled={!canEdit}
        {...(!canEdit ? { title: labels.readOnlyReason, describedBy: "api-source-read-only-reason" } : {})}
        onClick={() => { startEdit(selectedSource); }}>{labels.editSource}</Button>}
    />
    <div className="api-source-panel__detail-content">
      <InspectorFieldRow className="inspector-field-row--stacked" label={labels.url} help={labels.urlHint}>
        <a className="api-source-panel__url mono" href={selectedSource.url} target="_blank" rel="noreferrer">{selectedSource.url}</a>
      </InspectorFieldRow>
      <InspectorSection title={labels.sourceExpression}>
        <pre className="api-source-panel__expression mono">{selectedSource.expression || labels.noExpression}</pre>
      </InspectorSection>
      <div className="api-source-panel__status-detail">
        <Badge tone={statusFor(selectedSource).tone}>{statusFor(selectedSource).label}</Badge>
        <span className="muted">{selectedSource.lastFetchedAt === null ? labels.notTested : <time dateTime={selectedSource.lastFetchedAt}>{labels.lastQueried} {formatTimestamp(selectedSource.lastFetchedAt)}</time>}</span>
        {selectedSource.lastStatus === "error" ? <p className="api-source-panel__failure-detail" role="note">{apiSourceFailureText(selectedSource.lastError ?? "unreachable", locale)}</p> : null}
      </div>
    </div>
  </>;

  const stepTitle = creationStep === 0 ? labels.steps.url
    : creationStep === 1 ? labels.steps.expression
      : creationStep === 2 ? labels.steps.test : labels.steps.name;
  const stepDialog = <StepDialog
    opened={draft !== null && editingName === null}
    title={labels.createSource}
    size="content"
    description={labels.stepCounter(creationStep + 1, 4)}
    pending={busy || testing}
    onClose={requestCloseEditor}
    onSubmit={submitCreationStep}
    onKeyDown={submitWizardOnShortcut}
    footer={<div className="form-actions api-source-panel__step-actions">
      {creationStep === 0
        ? <Button variant="subtle" disabled={testing || busy} onClick={requestCloseEditor}>{labels.cancel}</Button>
        : <Button variant="neutral" disabled={testing || busy} onClick={() => { setCreationStep((step) => Math.max(0, step - 1)); }}>{labels.back}</Button>}
      {creationStep < 3 ? <Button type="submit" variant="primary"
        disabled={!canEdit || testing || busy || (creationStep === 0 && (draft?.url.trim().length ?? 0) === 0) || (creationStep === 2 && !testAttempted)}>{labels.continue}</Button>
        : <Button type="submit" variant="primary" disabled={!canEdit || busy || draft?.name.trim().length === 0}>{labels.save}</Button>}
    </div>}
  >
    {draft === null ? null : <div className="api-source-panel__step" data-step={String(creationStep + 1)}>
      {!canEdit ? <LockedReason id={editorReadOnlyReasonId} reason={labels.readOnlyReason} /> : null}
      <h3>{stepTitle}</h3>
      {creationStep === 0 ? <InspectorFieldRow className="inspector-field-row--stacked" label={labels.url} help={labels.urlHint}>
        <Field label={labels.url} labelHidden value={draft.url} onChange={(url) => updateDraft({ url })} disabled={!canEdit || busy || testing} mono />
      </InspectorFieldRow> : null}
      {creationStep === 1 ? <InspectorFieldRow className="inspector-field-row--stacked" label={labels.expression} help={labels.expressionHint}>
        <ExpressionField id="api-source-expression" label={labels.expression} value={draft.expression}
          onChange={(expression) => updateDraft({ expression })} maxLength={512} language={locale}
          messages={labels.expressionPicker} disabled={!canEdit || busy || testing} />
      </InspectorFieldRow> : null}
      {creationStep === 2 ? <>
        <div className="api-source-panel__test-summary">
          <p className="muted"><span>{labels.url}</span><code className="mono">{draft.url || "—"}</code></p>
        </div>
        <InspectorFieldRow className="inspector-field-row--stacked" label={labels.expression} help={labels.expressionHint}>
          <ExpressionField id="api-source-expression" label={labels.expression} value={draft.expression}
            onChange={(expression) => updateDraft({ expression })} maxLength={512} language={locale}
            messages={labels.expressionPicker} disabled={!canEdit || busy || testing} rows={3} />
        </InspectorFieldRow>
        <Button className="api-source-panel__test-button" variant="secondary" type="button" disabled={!canEdit || busy || testing || draft.url.trim().length === 0} onClick={() => { void testDraft(); }}>
          {testing ? labels.testing : labels.test}
        </Button>
        {testResultDisplay}
      </> : null}
      {creationStep === 3 ? <InspectorFieldRow className="inspector-field-row--stacked" label={labels.name} help={labels.nameHint}>
        <Field label={labels.name} labelHidden value={draft.name}
          onChange={(name) => { updateDraft({ name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 32) }); }}
          disabled={!canEdit || busy || testing} required />
      </InspectorFieldRow> : null}
      {formError === undefined ? null : <p className="api-source-test-result__error" role="alert">{formError}</p>}
    </div>}
  </StepDialog>;

  return <section className="api-source-panel" aria-label={labels.title}>
    <CollectionPage
      title={labels.title}
      headingLevel="h2"
      toolbar={<ListToolbar
          className="api-source-panel__list-toolbar"
          language={locale}
          searchLabel={labels.searchLabel}
          searchPlaceholder={labels.searchPlaceholder}
          searchClearLabel={labels.searchClearLabel}
          searchValue={searchTerm}
          onSearchChange={setSearchTerm}
          createPlacement="after-search"
          create={{ label: labels.addSource, onClick: startCreate, disabled: busy || !canEdit,
            ...(!canEdit && draft === null ? { reason: labels.readOnlyReason, reasonId: "api-source-read-only-reason", reasonVisible: false } : {}) }}
        />}
      list={list}
      detail={detail}
      detailOpen={selectedSource !== undefined}
      backLabel={labels.back}
      onCloseDetail={() => { setSelectedName(null); }}
    />
    {stepDialog}
    <FormDialog
      opened={draft !== null && editingName !== null}
      title={editingName === null ? labels.createSource : labels.editSource}
      confirmLabel={labels.save}
      cancelLabel={labels.cancel}
      onConfirm={() => { void save(); }}
      onCancel={requestCloseEditor}
      pending={busy || testing}
      confirmDisabled={!canEdit || draft === null || draft.name.trim().length === 0 || draft.url.trim().length === 0 || testing}
      {...(formError === undefined ? {} : { error: formError })}
    >
      {draft === null || editingName === null ? null : <div className="module-stack">
        {!canEdit ? <LockedReason id={editorReadOnlyReasonId} reason={labels.readOnlyReason} /> : null}
        <InspectorFieldRow label={labels.name} help={labels.nameHint}>
          <Field label={labels.name} value={draft.name} onChange={() => {}} disabled readOnly />
        </InspectorFieldRow>
        <InspectorFieldRow label={labels.url} help={labels.urlHint}>
          <Field label={labels.url} value={draft.url} onChange={(url) => updateDraft({ url })} disabled={!canEdit || busy || testing} mono />
        </InspectorFieldRow>
        <InspectorFieldRow label={labels.expression} help={labels.expressionHint}>
          <ExpressionField id="api-source-expression" label={labels.expression} value={draft.expression}
            onChange={(expression) => updateDraft({ expression })} maxLength={512} language={locale}
            messages={labels.expressionPicker} disabled={!canEdit || busy || testing} />
        </InspectorFieldRow>
        {draft.expression.trim().length === 0 ? <p className="muted" aria-live="polite">{labels.noExpression}</p> : null}
        <div className="form-actions">
          <Button type="button" disabled={!canEdit || busy || testing || draft.url.trim().length === 0} onClick={() => { void testDraft(); }}>
            {testing ? labels.testing : labels.test}
          </Button>
          <Button type="button" danger="subtle" disabled={!canEdit || busy || testing} onClick={() => { setDeleteError(undefined); setConfirmDeleteOpen(true); }}>{labels.delete}</Button>
        </div>
        {testResultDisplay}
      </div>}
    </FormDialog>
    <ConfirmDialog opened={editorGuard.confirmOpen} title={dashboard.module.unsavedChangesTitle}
      description={dashboard.module.unsavedChangesDescription}
      confirmLabel={dashboard.module.discardAndSwitch} cancelLabel={dashboard.module.continueEditing}
      onCancel={editorGuard.continueEditing} onConfirm={editorGuard.discardAndSwitch} danger />
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
  return [...sources.filter((entry) => entry.name !== source.name), source].sort((left, right) => left.name.localeCompare(right.name));
};

const removeSourceFromCache = (current: unknown, name: string): unknown => {
  const sources = Array.isArray(current) ? current as ApiSource[] : [];
  return sources.filter((entry) => entry.name !== name);
};
