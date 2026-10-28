import { useCallback, useRef, useState, type ReactElement } from "react";

import { moduleQueryKey, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardLanguage } from "../../../dashboard/locale";
import {
  Button,
  CollectionPage,
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  SaveStatus,
} from "../../../dashboard/ui";
import type { SaveStatusProps } from "../../../dashboard/ui/SaveStatus";
import type { ModulePanelProperties } from "../../contract";
import { QUIZ_SET_MAXIMUM_COUNT, QUIZ_SET_PAGE_SIZE, type QuizSet } from "../contracts";
import { quizPanelTexts } from "../locale";
import { createQuizSet, deleteQuizSet, loadQuizSet, loadQuizSets, loadQuizSettings, quizErrorCode } from "./service";
import QuizSetEditor, { type QuizEditorControl } from "./QuizSetEditor";
import QuizSettingsView from "./QuizSettingsView";
import "./panel.css";

const isQuizQuery = (channelId: string, query: { queryKey: readonly unknown[] }): boolean =>
  query.queryKey[0] === "channel" && query.queryKey[1] === channelId &&
  query.queryKey[2] === "module" && query.queryKey[3] === "quiz";

export default function QuizPanel({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const activeLanguage = language ?? dashboardLanguage();
  const labels = quizPanelTexts(activeLanguage);
  const queryClient = useDashboardQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedSetIdRef = useRef<string | null>(null);
  const activeEditorRef = useRef<QuizEditorControl | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatusProps | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<{ set: QuizSet; revision: number; session: symbol } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const collectionQuery = useModuleQuery(channelId, "quiz", `sets:${String(page)}:${search}`,
    (signal) => loadQuizSets(channelId, page, search, signal));
  const detailPart = selectedSetId === null ? "set:none" : `set:${selectedSetId}`;
  const detailQuery = useModuleQuery(channelId, "quiz", detailPart,
    (signal) => selectedSetId === null
      ? Promise.reject(new Error("quiz_set_not_selected"))
      : loadQuizSet(channelId, selectedSetId, signal),
    { enabled: selectedSetId !== null });
  const settingsQuery = useModuleQuery(channelId, "quiz", "settings", (signal) => loadQuizSettings(channelId, signal),
    { enabled: settingsOpen });
  const data = collectionQuery.data;
  const isManager = canManage !== false;

  const selectSet = useCallback((setId: string | null): void => {
    setSettingsOpen(false);
    if (selectedSetIdRef.current === setId) return;
    selectedSetIdRef.current = setId;
    setSelectedSetId(setId);
    setSaveStatus(null);
    setCreateError(undefined);
  }, []);

  const registerEditor = useCallback((editor: QuizEditorControl): (() => void) => {
    activeEditorRef.current = editor;
    return () => {
      if (activeEditorRef.current?.session !== editor.session) return;
      activeEditorRef.current = null;
      setSaveStatus(null);
    };
  }, []);

  const updateSaveStatus = useCallback((session: symbol, status: SaveStatusProps): void => {
    if (activeEditorRef.current?.session === session) setSaveStatus(status);
  }, []);

  const clearCreateError = useCallback((): void => { setCreateError(undefined); }, []);

  const requestSwitch = (proceed: () => void): void => {
    const editor = activeEditorRef.current;
    if (editor === null) proceed();
    else editor.guardSwitch(proceed);
  };

  const openSettings = (): void => {
    if (settingsOpen) return;
    requestSwitch(() => {
      selectSet(null);
      setSettingsOpen(true);
    });
  };

  const createSet = async (): Promise<void> => {
    if (!isManager || creating) return;
    const sourceEditor = activeEditorRef.current;
    const sourceSetId = selectedSetIdRef.current;
    setCreating(true);
    setCreateError(undefined);
    try {
      const created = await createQuizSet(channelId, labels.newSet);
      const stillOnSource = selectedSetIdRef.current === sourceSetId && (
        sourceEditor === null
          ? activeEditorRef.current === null
          // Ask the live control: the captured one may have closed over stale state.
          : activeEditorRef.current?.session === sourceEditor.session && !activeEditorRef.current.isDirty()
      );
      if (stillOnSource) {
        queryClient.setQueryData(moduleQueryKey(channelId, "quiz", `set:${created.id}`), created);
        selectSet(created.id);
      }
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch (failure: unknown) {
      const code = quizErrorCode(failure);
      const stillOnSource = selectedSetIdRef.current === sourceSetId && (
        sourceEditor === null
          ? activeEditorRef.current === null
          : activeEditorRef.current?.session === sourceEditor.session
      );
      if (stillOnSource) setCreateError(code === "quiz_set_limit_reached" ? labels.maximumSets : labels.createError);
    } finally {
      setCreating(false);
    }
  };

  const requestCreate = (): void => {
    requestSwitch(() => { void createSet(); });
  };

  const openDelete = (set: QuizSet, revision: number, session: symbol): void => {
    setDeleteTarget({ set, revision, session });
    setDeleteError(undefined);
  };

  const removeSet = async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null || !isManager || deleting) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await deleteQuizSet(channelId, target.set.id, target.revision);
      if (activeEditorRef.current?.session === target.session && selectedSetIdRef.current === target.set.id) {
        setDeleteTarget(null);
        selectSet(null);
      }
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch {
      if (activeEditorRef.current?.session === target.session) setDeleteError(labels.deleteError);
    } finally {
      setDeleting(false);
    }
  };

  const setRows = data?.sets.map((set) => (
    <button
      className={`quiz-set-row${selectedSetId === set.id ? " is-selected" : ""}`}
      type="button"
      aria-pressed={selectedSetId === set.id}
      key={set.id}
      onClick={() => {
        if (set.id === selectedSetIdRef.current) return;
        requestSwitch(() => { selectSet(set.id); });
      }}
    >
      <span className="quiz-set-row__name">{set.name}</span>
      <span className="quiz-set-row__count">{labels.questionCount(set.questionCount)}</span>
    </button>
  ));

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / QUIZ_SET_PAGE_SIZE));
  const createReason = search.trim().length === 0 && (data?.total ?? 0) >= QUIZ_SET_MAXIMUM_COUNT ? labels.maximumSets : undefined;
  const listToolbar = (
    <div className="quiz-collection-toolbar">
      <div className="quiz-collection-toolbar__top">
        <Field
          variant="search"
          label={labels.search}
          clearLabel={labels.clearSearch}
          value={search}
          onChange={(value) => { setSearch(value); setPage(1); }}
          placeholder={labels.searchPlaceholder}
        />
        <Button
          variant="primary"
          icon="add"
          disabled={!isManager || creating || createReason !== undefined}
          {...(createReason === undefined ? {} : { describedBy: "quiz-create-reason" })}
          onClick={requestCreate}
        >{creating ? labels.creatingSet : labels.newSet}</Button>
      </div>
      <div className="quiz-collection-pagination" aria-label={labels.page(page, totalPages)}>
        <Button variant="subtle" icon="chevron-left" iconOnly ariaLabel={labels.previousPage} disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} />
        <span>{labels.page(page, totalPages)}</span>
        <Button variant="subtle" icon="chevron-right" iconOnly ariaLabel={labels.nextPage} disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} />
        {createReason === undefined ? null : <span id="quiz-create-reason" className="quiz-collection-pagination__note" role="note" title={createReason}>{createReason}</span>}
      </div>
    </div>
  );

  const selectedSet = detailQuery.data?.id === selectedSetId ? detailQuery.data : undefined;
  const empty = data !== undefined && data.total === 0;
  const detail = settingsOpen ? (
    settingsQuery.data === undefined ? (
      <div className="quiz-editor-placeholder" aria-busy={settingsQuery.isPending}>
        {settingsQuery.isError ? <>
          <p>{labels.settingsLoadError}</p>
          <Button disabled={settingsQuery.isFetching} onClick={() => { void settingsQuery.refetch(); }}>{labels.retry}</Button>
        </> : null}
      </div>
    ) : (
      <QuizSettingsView
        channelId={channelId}
        language={activeLanguage}
        canManage={isManager}
        state={settingsQuery.data}
        onRegisterEditor={registerEditor}
        onSaveStatus={updateSaveStatus}
      />
    )
  ) : selectedSet !== undefined && selectedSetId !== null ? (
    <QuizSetEditor
      key={selectedSetId}
      channelId={channelId}
      language={activeLanguage}
      canManage={isManager}
      deleting={deleting}
      set={selectedSet}
      {...(createError === undefined ? {} : { createError })}
      onRegisterEditor={registerEditor}
      onSaveStatus={updateSaveStatus}
      onClearCreateError={clearCreateError}
      onDelete={openDelete}
    />
  ) : selectedSetId !== null ? (
    <div className="quiz-editor-placeholder" aria-busy={detailQuery.isPending}>
      {detailQuery.isError ? labels.saveError : null}
    </div>
  ) : empty ? (
    <EmptyState title={labels.noSets} description={labels.noSetsDescription} />
  ) : <div className="quiz-editor-placeholder">{labels.selectSet}</div>;

  const fallbackSaveStatus: SaveStatusProps = {
    persistent: true,
    dirty: false,
    pending: false,
    saveDisabled: true,
    discardDisabled: true,
    ...(createError === undefined ? {} : { error: createError }),
    onSave: () => undefined,
    onDiscard: () => undefined,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
  };

  return <section className="module-stack quiz-panel" aria-label={labels.title}>
    <CollectionPage
      title={labels.title}
      heading={<div className="quiz-page-heading"><PageHeader title={labels.title} subtitle={labels.subtitle} icon={<Icon name="quiz" size={20} />} pageActions={<Button variant={settingsOpen ? "secondary" : "neutral"} icon="tabSettings" ariaPressed={settingsOpen} onClick={openSettings}>{labels.settings}</Button>} /><div className="quiz-page-save"><SaveStatus {...(saveStatus ?? fallbackSaveStatus)} /></div></div>}
      toolbar={listToolbar}
      list={collectionQuery.isError && data === undefined
        ? <div className="quiz-list-error" role="status">{labels.saveError}</div>
        : collectionQuery.isPending && data === undefined
        ? <div className="quiz-list-placeholder" aria-busy="true" />
        : setRows === undefined || setRows.length === 0
          ? <div className="quiz-list-empty" />
          : <div className="quiz-set-list">{setRows}</div>}
      empty={collectionQuery.isError ? labels.saveError : labels.noSets}
      detail={detail}
      detailOpen={selectedSetId !== null || settingsOpen}
      onCloseDetail={() => requestSwitch(() => { selectSet(null); })}
      backLabel={labels.selectSet}
    />
    <ConfirmDialog
      opened={deleteTarget !== null}
      title={labels.deleteTitle}
      description={labels.deleteDescription}
      confirmLabel={deleting ? labels.deleting : labels.confirm}
      cancelLabel={labels.cancel}
      danger
      onConfirm={() => { void removeSet(); }}
      onCancel={() => { setDeleteTarget(null); }}
      pending={deleting}
      {...(deleteError === undefined ? {} : { error: deleteError })}
    />
  </section>;
}
