import { useEffect, useRef, useState, type ReactElement } from "react";

import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardLanguage } from "../../../dashboard/locale";
import {
  Button, CollectionPage, ConfirmDialog, EmptyState, Field, Icon, NativeRadio,
  PageHeader, SaveStatus, SwitchRow, registerDashboardNavigationGuard, useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import {
  QUIZ_OPTION_MAXIMUM_COUNT,
  QUIZ_OPTION_MAXIMUM_LENGTH,
  QUIZ_QUESTION_MAXIMUM_COUNT,
  QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH,
  QUIZ_SET_MAXIMUM_COUNT,
  QUIZ_SET_PAGE_SIZE,
  type QuizSet,
  type QuizSetInput,
} from "../contracts";
import { validateQuizSet } from "../domain/sets";
import { quizPanelTexts } from "../locale";
import { createQuizSet, deleteQuizSet, loadQuizSet, loadQuizSets, quizErrorCode, saveQuizSet } from "./service";
import "./panel.css";

const draftFromSet = (set: QuizSet): QuizSetInput => ({
  name: set.name,
  questions: set.questions.map(({ text, options, correctIndex, enabled }) => ({ text, options: [...options], correctIndex, enabled })),
});
const isQuizQuery = (channelId: string, query: { queryKey: readonly unknown[] }): boolean =>
  query.queryKey[0] === "channel" && query.queryKey[1] === channelId &&
  query.queryKey[2] === "module" && query.queryKey[3] === "quiz";
const characterCount = (value: string): number => Array.from(value).length;

export default function QuizPanel({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const activeLanguage = language ?? dashboardLanguage();
  const labels = quizPanelTexts(activeLanguage);
  const queryClient = useDashboardQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const selectedSetIdRef = useRef<string | null>(null);
  const draftGenerationRef = useRef(0);
  const selectedGenerationRef = useRef<{ id: string | null; generation: number }>({ id: null, generation: 0 });
  const detailSnapshotsRef = useRef(new WeakMap<QuizSet, { id: string; generation: number }>());
  const savePromisesRef = useRef(new Map<string, Promise<string | null>>());
  const [baseline, setBaseline] = useState<QuizSet | null>(null);
  const [draft, setDraft] = useState<QuizSetInput | null>(null);
  const [savingSetIds, setSavingSetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [reloadingSetIds, setReloadingSetIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [validationCode, setValidationCode] = useState<Parameters<typeof labels.validationError>[0] | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const collectionQuery = useModuleQuery(channelId, "quiz", `sets:${String(page)}:${search}`,
    (signal) => loadQuizSets(channelId, page, search, signal));
  const detailPart = selectedSetId === null ? "set:none" : `set:${selectedSetId}`;
  const detailQuery = useModuleQuery(channelId, "quiz", detailPart,
    (signal) => {
      if (selectedSetId === null) return Promise.reject(new Error("quiz_set_not_selected"));
      const id = selectedSetId;
      const generation = draftGenerationRef.current;
      return loadQuizSet(channelId, id, signal).then((loaded) => {
        detailSnapshotsRef.current.set(loaded, { id, generation });
        return loaded;
      });
    },
    { enabled: selectedSetId !== null });
  const data = collectionQuery.data;
  const isManager = canManage !== false;
  const saving = selectedSetId !== null && savingSetIds.has(selectedSetId);
  const reloading = selectedSetId !== null && reloadingSetIds.has(selectedSetId);
  const dirty = baseline !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftFromSet(baseline));
  const validated = draft === null ? null : validateQuizSet(draft);

  useEffect(() => {
    const loaded = detailQuery.data;
    if (loaded === undefined || loaded.id !== selectedSetId) return;
    const selectedChanged = baseline?.id !== loaded.id;
    const baselineRevision = baseline?.revision;
    const cleanRevisionChanged = !dirty && baselineRevision !== undefined && loaded.revision > baselineRevision;
    if (selectedSetIdRef.current !== loaded.id) return;
    const selection = selectedGenerationRef.current;
    const request = detailSnapshotsRef.current.get(loaded);
    const currentRequest = request?.id === loaded.id && request.generation === draftGenerationRef.current;
    const currentSelection = selectedChanged && selection.id === loaded.id && selection.generation === draftGenerationRef.current && currentRequest;
    const currentCleanRefresh = !selectedChanged && cleanRevisionChanged && currentRequest;
    if (!currentSelection && !currentCleanRefresh) return;
    draftGenerationRef.current += 1;
    setBaseline(loaded);
    setDraft(draftFromSet(loaded));
    setValidationCode(null);
    setSaveError(undefined);
    setConflicted(false);
  }, [baseline?.id, baseline?.revision, detailQuery.data, dirty, selectedSetId]);

  const markDirty = (next: QuizSetInput): void => {
    draftGenerationRef.current += 1;
    setDraft(next);
    setSaved(false);
    setSaveError(undefined);
    setValidationCode(null);
  };

  const discardDraft = (): void => {
    draftGenerationRef.current += 1;
    if (baseline !== null) setDraft(draftFromSet(baseline));
    setValidationCode(null);
    setSaveError(undefined);
    setSaved(false);
  };

  const saveDraft = (): Promise<string | null> => {
    if (baseline === null || draft === null) return Promise.resolve(null);
    if (selectedSetIdRef.current !== baseline.id) return Promise.resolve(null);
    const existingSave = savePromisesRef.current.get(baseline.id);
    if (existingSave !== undefined) return existingSave;
    const check = validateQuizSet(draft);
    if (!check.ok) {
      setValidationCode(check.code);
      return Promise.resolve(labels.validationError(check.code));
    }
    const selectedId = baseline.id;
    const generation = draftGenerationRef.current;
    setSavingSetIds((current) => new Set(current).add(selectedId));
    setSaveError(undefined);
    let operation: Promise<string | null> = Promise.resolve(null);
    operation = (async (): Promise<string | null> => {
      let obsoleteDraftMessage: string | undefined;
      try {
        const savedSet = await runModuleQueryWrite(
          queryClient,
          channelId,
          "quiz",
          `set:${baseline.id}`,
          (baselineRevision) => saveQuizSet(channelId, baseline.id, baselineRevision ?? baseline.revision, check.value),
          { baselineRevision: baseline.revision, updateCache: (_current, saved) => saved },
        );
        if (selectedSetIdRef.current === selectedId && draftGenerationRef.current === generation) {
          draftGenerationRef.current += 1;
          setBaseline(savedSet);
          setDraft(draftFromSet(savedSet));
          setSaved(true);
          setValidationCode(null);
          setConflicted(false);
        } else if (selectedSetIdRef.current === selectedId) {
          obsoleteDraftMessage = labels.draftChangedWhileSaving;
        }
        await queryClient.invalidateQueries({
          predicate: (query) => isQuizQuery(channelId, query) && typeof query.queryKey[4] === "string" && query.queryKey[4].startsWith("sets:"),
        });
        return obsoleteDraftMessage ?? null;
      } catch (error: unknown) {
        if (selectedSetIdRef.current !== selectedId || draftGenerationRef.current !== generation) return null;
        const code = quizErrorCode(error);
        if (code === "quiz_set_conflict" || code === "quiz_set_deleted") setConflicted(true);
        const message = code === "quiz_set_conflict" || code === "quiz_set_deleted"
          ? labels.conflict
          : code === "quiz_set_not_found" ? labels.conflict : labels.saveError;
        setSaveError(message);
        return message;
      } finally {
        if (savePromisesRef.current.get(selectedId) === operation) savePromisesRef.current.delete(selectedId);
        setSavingSetIds((current) => {
          const next = new Set(current);
          next.delete(selectedId);
          return next;
        });
      }
    })();
    savePromisesRef.current.set(selectedId, operation);
    return operation;
  };

  const guard = useDraftGuard(dirty, saveDraft, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);
  const requestSwitch = (proceed: () => void): void => { guard.guardSwitch(proceed); };

  const createSet = async (): Promise<void> => {
    if (!isManager) return;
    const selectedId = selectedSetIdRef.current;
    const generation = draftGenerationRef.current;
    setCreating(true);
    try {
      const created = await createQuizSet(channelId, labels.newSet);
      if (selectedSetIdRef.current === selectedId && draftGenerationRef.current === generation) {
        setBaseline(created);
        setDraft(draftFromSet(created));
        selectSet(created.id);
        setSaved(false);
        setSaveError(undefined);
        setConflicted(false);
        setValidationCode(null);
      }
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch (error: unknown) {
      if (selectedSetIdRef.current !== selectedId || draftGenerationRef.current !== generation) return;
      const code = quizErrorCode(error);
      setSaveError(code === "quiz_set_limit_reached" ? labels.maximumSets : labels.createError);
    } finally {
      setCreating(false);
    }
  };

  function selectSet(setId: string | null): void {
    if (selectedSetIdRef.current === setId) return;
    selectedSetIdRef.current = setId;
    draftGenerationRef.current += 1;
    selectedGenerationRef.current = { id: setId, generation: draftGenerationRef.current };
    setSelectedSetId(setId);
  }

  const chooseSet = (setId: string): void => {
    if (setId === selectedSetId) return;
    requestSwitch(() => {
      selectSet(setId);
      setSaved(false);
      setSaveError(undefined);
      setConflicted(false);
      setValidationCode(null);
    });
  };

  const removeSet = async (): Promise<void> => {
    if (baseline === null || selectedSetIdRef.current !== baseline.id) return;
    const selectedId = baseline.id;
    const generation = draftGenerationRef.current;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await deleteQuizSet(channelId, baseline.id, baseline.revision);
      if (selectedSetIdRef.current === selectedId && draftGenerationRef.current === generation) {
        setDeleteOpen(false);
        selectSet(null);
        setBaseline(null);
        setDraft(null);
        setConflicted(false);
        setSaveError(undefined);
      }
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch {
      if (selectedSetIdRef.current === selectedId && draftGenerationRef.current === generation) setDeleteError(labels.deleteError);
    } finally {
      setDeleting(false);
    }
  };

  const reloadConflict = async (): Promise<void> => {
    const selectedId = selectedSetIdRef.current;
    if (selectedId === null) return;
    const generation = draftGenerationRef.current;
    setReloadingSetIds((current) => new Set(current).add(selectedId));
    let reloaded: QuizSet;
    try {
      reloaded = await refetchModuleQueryData<QuizSet>(queryClient, channelId, "quiz", `set:${selectedId}`);
    } catch {
      setReloadingSetIds((current) => {
        const next = new Set(current);
        next.delete(selectedId);
        return next;
      });
      return; // Keep the draft and the conflict state when the reload fails.
    }
    if (selectedSetIdRef.current !== selectedId || draftGenerationRef.current !== generation) {
      setReloadingSetIds((current) => {
        const next = new Set(current);
        next.delete(selectedId);
        return next;
      });
      return;
    }
    draftGenerationRef.current += 1;
    setBaseline(reloaded);
    setDraft(draftFromSet(reloaded));
    setConflicted(false);
    setSaveError(undefined);
    setValidationCode(null);
    setReloadingSetIds((current) => {
      const next = new Set(current);
      next.delete(selectedId);
      return next;
    });
  };

  const updateQuestion = (index: number, change: (question: QuizSetInput["questions"][number]) => QuizSetInput["questions"][number]): void => {
    if (draft === null) return;
    const questions = draft.questions.map((question, current) => current === index ? change(question) : question);
    markDirty({ ...draft, questions });
  };

  const reorderQuestion = (index: number, direction: -1 | 1): void => {
    if (draft === null) return;
    const targetIndex = index + direction;
    const current = draft.questions[index];
    const target = draft.questions[targetIndex];
    if (current === undefined || target === undefined) return;
    const questions = [...draft.questions];
    questions[index] = target;
    questions[targetIndex] = current;
    markDirty({ ...draft, questions });
  };

  const questionEditor = (draft === null || baseline === null ? null : (
    <div className="quiz-editor-content">
      <Field
        label={labels.setName}
        value={draft.name}
        onChange={(name) => { markDirty({ ...draft, name }); }}
        placeholder={labels.setNamePlaceholder}
        disabled={!isManager}
        errorInDescription
        {...(validationCode === "set_name_required" ? { error: labels.validationError(validationCode) } : {})}
      />
      <div className="quiz-question-toolbar">
        <h2>{labels.questionCount(draft.questions.length)}</h2>
        <Button
          icon="add"
          variant="secondary"
          onClick={() => markDirty({ ...draft, questions: [...draft.questions, { text: "", options: ["", ""], correctIndex: 0, enabled: true }] })}
          disabled={!isManager || draft.questions.length >= QUIZ_QUESTION_MAXIMUM_COUNT}
        >{labels.addQuestion}</Button>
      </div>
      <div className="quiz-question-list">
        {draft.questions.map((question, questionIndex) => (
          <section className="quiz-question" key={questionIndex} aria-label={labels.question(questionIndex + 1)}>
            <div className="quiz-question__heading">
              <h3>{labels.question(questionIndex + 1)}</h3>
              <div className="quiz-question__actions">
                <Button variant="subtle" icon="sortAscending" iconOnly ariaLabel={labels.moveUp(questionIndex + 1)} disabled={!isManager || questionIndex === 0} onClick={() => reorderQuestion(questionIndex, -1)} />
                <Button variant="subtle" icon="sortDescending" iconOnly ariaLabel={labels.moveDown(questionIndex + 1)} disabled={!isManager || questionIndex === draft.questions.length - 1} onClick={() => reorderQuestion(questionIndex, 1)} />
                <Button variant="subtle" icon="remove" iconOnly ariaLabel={labels.removeQuestion(questionIndex + 1)} disabled={!isManager} onClick={() => {
                  markDirty({ ...draft, questions: draft.questions.filter((_, index) => index !== questionIndex) });
                }} />
              </div>
            </div>
            <Field
              label={labels.questionText}
              value={question.text}
              onChange={(text) => updateQuestion(questionIndex, (current) => ({ ...current, text }))}
              placeholder={labels.questionPlaceholder}
              maxLength={QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH}
              countLength={characterCount}
              countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
              disabled={!isManager}
              errorInDescription
              {...(validationCode === "question_text_required" && question.text.trim().length === 0 ? { error: labels.validationError(validationCode) } : {})}
            />
            <fieldset className="quiz-options">
              <legend>{labels.options}</legend>
              <p className="quiz-options__hint">{labels.correctAnswerHint}</p>
              <div className="quiz-options__list">
                {question.options.map((option, optionIndex) => (
                  <div className={`quiz-option-chip${question.correctIndex === optionIndex ? " is-correct" : ""}`} key={optionIndex}>
                    <NativeRadio
                      name={`quiz-correct-${String(questionIndex)}`}
                      value={String(optionIndex)}
                      checked={question.correctIndex === optionIndex}
                      onChange={() => updateQuestion(questionIndex, (current) => ({ ...current, correctIndex: optionIndex }))}
                      ariaLabel={labels.correctAnswer(optionIndex + 1, questionIndex + 1)}
                      disabled={!isManager}
                    />
                    <Field
                      label={labels.option(optionIndex + 1)}
                      value={option}
                      onChange={(value) => updateQuestion(questionIndex, (current) => ({
                        ...current,
                        options: current.options.map((candidate, index) => index === optionIndex ? value : candidate),
                      }))}
                      maxLength={QUIZ_OPTION_MAXIMUM_LENGTH}
                      countLength={characterCount}
                      countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
                      disabled={!isManager}
                      className="quiz-option-chip__field"
                      errorInDescription
                      {...(validationCode === "option_invalid" && option.trim().length === 0 ? { error: labels.optionRequired } : {})}
                    />
                    {question.options.length > 2 ? <Button
                      variant="subtle"
                      icon="remove"
                      iconOnly
                      ariaLabel={labels.removeOption(optionIndex + 1)}
                      disabled={!isManager}
                      onClick={() => updateQuestion(questionIndex, (current) => ({
                        ...current,
                        options: current.options.filter((_, index) => index !== optionIndex),
                        correctIndex: current.correctIndex === optionIndex
                          ? 0
                          : current.correctIndex > optionIndex ? current.correctIndex - 1 : current.correctIndex,
                      }))}
                    /> : null}
                  </div>
                ))}
              </div>
              {question.options.length < QUIZ_OPTION_MAXIMUM_COUNT ? <Button
                variant="subtle"
                icon="add"
                onClick={() => updateQuestion(questionIndex, (current) => ({ ...current, options: [...current.options, ""] }))}
                disabled={!isManager}
              >{labels.addOption}</Button> : null}
            </fieldset>
            <SwitchRow
              label={labels.enabled}
              checked={question.enabled}
              onChange={(enabled) => updateQuestion(questionIndex, (current) => ({ ...current, enabled }))}
              disabled={!isManager}
            />
          </section>
        ))}
      </div>
    </div>
  ));

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / QUIZ_SET_PAGE_SIZE));
  const saveStatus = (
    <SaveStatus
      persistent
      dirty={dirty}
      pending={saving}
      saved={saved}
      {...(saveError === undefined ? {} : { error: saveError })}
      invalid={validated !== null && !validated.ok}
      {...(validationCode === null ? {} : { invalidMessage: labels.validationError(validationCode) })}
      {...(conflicted ? { conflict: { message: labels.conflict, reloadLabel: reloading ? labels.reloading : labels.reload, reloadPending: reloading, onReload: () => { void reloadConflict(); } } } : {})}
      onSave={() => { void saveDraft(); }}
      onInvalidSave={() => {
        if (validated !== null && !validated.ok) setValidationCode(validated.code);
      }}
      onDiscard={discardDraft}
      saveLabel={labels.save}
      discardLabel={labels.discard}
      savedLabel={labels.saved}
      pendingLabel={labels.saving}
      saveDisabled={!isManager || baseline === null}
      discardDisabled={!isManager}
    />
  );

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
          onClick={() => requestSwitch(() => { void createSet(); })}
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

  const setRows = data?.sets.map((set) => (
    <button
      className={`quiz-set-row${selectedSetId === set.id ? " is-selected" : ""}`}
      type="button"
      aria-pressed={selectedSetId === set.id}
      key={set.id}
      onClick={() => chooseSet(set.id)}
    >
      <span className="quiz-set-row__name">{set.name}</span>
      <span className="quiz-set-row__count">{labels.questionCount(set.questionCount)}</span>
    </button>
  ));

  const selectedLoaded = detailQuery.data?.id === selectedSetId;
  const empty = data !== undefined && data.total === 0;
  const detail = selectedLoaded && baseline?.id === selectedSetId && questionEditor !== null ? (
    <section className="module-stack quiz-detail" aria-label={labels.title}>
      <div className="quiz-detail__toolbar">
        {isManager ? <Button variant="subtle" icon="remove" disabled={deleting} onClick={() => { setDeleteError(undefined); setDeleteOpen(true); }}>{deleting ? labels.deleting : labels.delete}</Button> : null}
      </div>
      {questionEditor}
    </section>
  ) : selectedSetId !== null ? (
    <div className="quiz-editor-placeholder" aria-busy={detailQuery.isPending}>
      {detailQuery.isError ? labels.saveError : null}
    </div>
  ) : empty ? (
    <EmptyState title={labels.noSets} description={labels.noSetsDescription} />
  ) : <div className="quiz-editor-placeholder">{labels.selectSet}</div>;

  return <section className="module-stack quiz-panel" aria-label={labels.title}>
    <CollectionPage
      title={labels.title}
      heading={<div className="quiz-page-heading"><PageHeader title={labels.title} subtitle={labels.subtitle} icon={<Icon name="quiz" size={20} />} /><div className="quiz-page-save">{saveStatus}</div></div>}
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
      detailOpen={selectedSetId !== null}
      onCloseDetail={() => guard.guardSwitch(() => { selectSet(null); })}
      closeDetailDisabled={guard.confirmOpen}
      backLabel={labels.selectSet}
    />
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.unsavedTitle}
      description={labels.unsavedDescription}
      confirmLabel={labels.saveAndContinue}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.discardAndSwitch, onClick: guard.discardAndSwitch }}
      onConfirm={() => { void guard.saveAndSwitch(); }}
      onCancel={guard.continueEditing}
      pending={guard.saving}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
    />
    <ConfirmDialog
      opened={deleteOpen}
      title={labels.deleteTitle}
      description={labels.deleteDescription}
      confirmLabel={deleting ? labels.deleting : labels.confirm}
      cancelLabel={labels.cancel}
      danger
      onConfirm={() => { void removeSet(); }}
      onCancel={() => { setDeleteOpen(false); }}
      pending={deleting}
      {...(deleteError === undefined ? {} : { error: deleteError })}
    />
  </section>;
}
