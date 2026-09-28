import { useCallback, useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, CodeField, Field, InspectorFieldRow, InspectorSection } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { ApiSource } from "../contracts";
import { apiSourcePanelTexts } from "./locale";
import { createApiSource, deleteApiSource, loadApiSources, updateApiSource } from "./service";

interface SourceDraft {
  name: string;
  url: string;
  expression: string;
}

const emptyDraft = (): SourceDraft => ({ name: "", url: "", expression: "" });

const apiErrorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

const disallowedFunctionName = (error: unknown): string | null => {
  if (!(error instanceof PanelApiError) || typeof error.details !== "object" || error.details === null || Array.isArray(error.details)) return null;
  const functionName = (error.details as { functionName?: unknown }).functionName;
  return typeof functionName === "string" ? functionName : null;
};

export default function ApiSourcePanel({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const locale = language ?? "de";
  const labels = apiSourcePanelTexts(locale);
  const canEdit = canManage ?? false;
  const [sources, setSources] = useState<readonly ApiSource[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setSources(await loadApiSources(channelId));
  }, [channelId]);

  useEffect(() => {
    let active = true;
    loadApiSources(channelId).then((next) => {
      if (active) setSources(next);
    }).catch(() => {
      if (active) setError(labels.loadFailed);
    });
    return () => { active = false; };
  }, [channelId, labels.loadFailed]);

  const startCreate = (): void => {
    setEditingName(null);
    setDraft(emptyDraft());
    setConfirmDelete(false);
    setError("");
  };

  const startEdit = (source: ApiSource): void => {
    setEditingName(source.name);
    setDraft({ name: source.name, url: source.url, expression: source.expression });
    setConfirmDelete(false);
    setError("");
  };

  const save = async (): Promise<void> => {
    if (draft === null || !canEdit) return;
    const normalized = { ...draft, name: draft.name.trim(), url: draft.url.trim(), expression: draft.expression.trim() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (editingName === null) {
        await createApiSource(channelId, normalized);
        setNotice(labels.created);
      } else {
        const current = sources.find((source) => source.name === editingName);
        if (current === undefined) throw new Error("api_source_not_found");
        await updateApiSource(channelId, editingName, { url: normalized.url, expression: normalized.expression, revision: current.revision });
        setNotice(labels.saved);
      }
      await refresh();
      setDraft(null);
      setEditingName(null);
    } catch (failure: unknown) {
      const code = apiErrorCode(failure);
      const functionName = disallowedFunctionName(failure);
      setError(code === "api_source_function_not_allowed" && functionName !== null ? labels.functionNotAllowed(functionName)
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
    if (source === undefined || !canEdit) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteApiSource(channelId, source);
      await refresh();
      setDraft(null);
      setEditingName(null);
      setNotice(labels.deleted);
    } catch (failure: unknown) {
      setError(apiErrorCode(failure) === "api_source_management_denied" ? labels.denied : labels.saveFailed);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return <section className="module-stack api-source-panel" aria-label={labels.title}>
    {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
    {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
    {!canEdit ? <p className="lock-reason">{labels.readOnlyReason}</p> : null}
    <p className="muted">{labels.explanation}</p>
    <InspectorSection title={labels.sourceList}>
      {sources.length === 0 ? <p className="muted">{labels.empty}</p> : <ul className="api-source-panel__list">
        {sources.map((source) => <li key={source.name}>
          <Button size="compact" variant={editingName === source.name ? "secondary" : "neutral"} onClick={() => startEdit(source)}>
            <code>{source.name}</code>
          </Button>
          <span className="muted">{new URL(source.url).hostname}</span>
        </li>)}
      </ul>}
      {draft === null ? <Button disabled={!canEdit || busy} onClick={startCreate}>{labels.addSource}</Button> : null}
    </InspectorSection>
    {draft === null ? null : <InspectorSection title={editingName === null ? labels.createSource : labels.editSource}>
      <InspectorFieldRow label={labels.name} help={labels.nameHint}>
        <Field label={labels.name} value={draft.name} onChange={(name) => setDraft({ ...draft, name: name.toLowerCase().replace(/[^a-z0-9_]/gu, "").slice(0, 32) })} disabled={busy || !canEdit || editingName !== null} readOnly={editingName !== null} />
      </InspectorFieldRow>
      <InspectorFieldRow label={labels.url} help={labels.urlHint}>
        <Field label={labels.url} value={draft.url} onChange={(url) => setDraft({ ...draft, url })} disabled={busy || !canEdit} mono />
      </InspectorFieldRow>
      <InspectorFieldRow label={labels.expression} help={labels.expressionHint}>
        <CodeField id="api-source-expression" label={labels.expression} value={draft.expression} onChange={(expression) => setDraft({ ...draft, expression })} maxLength={512} disabled={busy || !canEdit} />
      </InspectorFieldRow>
      {draft.expression.trim().length === 0 ? <p className="muted">{labels.noExpression}</p> : null}
      <div className="form-actions">
        <Button variant="primary" disabled={!canEdit || busy || draft.name.length === 0 || draft.url.length === 0} onClick={() => { void save(); }}>{labels.save}</Button>
        <Button disabled={busy} onClick={() => { setDraft(null); setEditingName(null); setConfirmDelete(false); }}>{labels.cancel}</Button>
        {editingName === null ? null : <Button danger="subtle" disabled={!canEdit || busy} onClick={() => { void remove(); }}>{confirmDelete ? labels.confirmDelete : labels.delete}</Button>}
      </div>
    </InspectorSection>}
  </section>;
}
