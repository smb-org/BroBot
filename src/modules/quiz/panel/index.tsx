import { useEffect, useState, type ReactElement } from "react";

import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardLanguage } from "../../../dashboard/locale";
import {
  Button, CollectionPage, ConfirmDialog, EmptyState, Field, Icon, ListToolbar, NativeRadio,
  PageHeader, SaveStatus, SwitchRow, useDraftGuard,
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
  const [baseline, setBaseline] = useState<QuizSet | null>(null);
  const [draft, setDraft] = useState<QuizSetInput | null>(null);
  const [pending, setPending] = useState(false);
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
    (signal) => selectedSetId === null ? Promise.reject(new Error("quiz_set_not_selected")) : loadQuizSet(channelId, selectedSetId, signal),
    { enabled: selectedSetId !== null });
  const data = collectionQuery.data;
  const isManager = canManage !== false;
  const dirty = baseline !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftFromSet(baseline));
  const validated = draft === null ? null : validateQuizSet(draft);

  /* eslint-disable react-hooks/set-state-in-effect -- A server snapshot initializes the selected editor draft and clean external revisions. */
  useEffect(() => {
    const loaded = detailQuery.data;
    if (loaded === undefined || loaded.id !== selectedSetId) return;
    const selectedChanged = baseline?.id !== loaded.id;
    const baselineRevision = baseline?.revision;
    const cleanRevisionChanged = !dirty && baselineRevision !== undefined && loaded.revision > baselineRevision;
    if (!selectedChanged && !cleanRevisionChanged) return;
    setBaseline(loaded);
    setDraft(draftFromSet(loaded));
    setValidationCode(null);
    setSaveError(undefined);
    setConflicted(false);
  }, [baseline?.id, baseline?.revision, detailQuery.data, dirty, selectedSetId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const markDirty = (next: QuizSetInput): void => {
    setDraft(next);
    setSaved(false);
    setSaveError(undefined);
    setValidationCode(null);
  };

  const discardDraft = (): void => {
    if (baseline !== null) setDraft(draftFromSet(baseline));
    setValidationCode(null);
    setSaveError(undefined);
    setSaved(false);
  };

  const saveDraft = async (): Promise<string | null> => {
    if (baseline === null || draft === null) return null;
    const check = validateQuizSet(draft);
    if (!check.ok) {
      setValidationCode(check.code);
      return labels.validationError(check.code);
    }
    setPending(true);
    setSaveError(undefined);
    try {
      const savedSet = await runModuleQueryWrite(
        queryClient,
        channelId,
        "quiz",
        `set:${baseline.id}`,
        (baselineRevision) => saveQuizSet(channelId, baseline.id, baselineRevision ?? baseline.revision, check.value),
        { baselineRevision: baseline.revision, updateCache: (_current, saved) => saved },
      );
      setBaseline(savedSet);
      setDraft(draftFromSet(savedSet));
      setSaved(true);
      setValidationCode(null);
      setConflicted(false);
      await queryClient.invalidateQueries({
        predicate: (query) => isQuizQuery(channelId, query) && typeof query.queryKey[4] === "string" && query.queryKey[4].startsWith("sets:"),
      });
      return null;
    } catch (error: unknown) {
      const code = quizErrorCode(error);
      if (code === "quiz_set_conflict" || code === "quiz_set_deleted") setConflicted(true);
      const message = code === "quiz_set_conflict" || code === "quiz_set_deleted"
        ? labels.conflict
        : code === "quiz_set_not_found" ? labels.conflict : labels.saveError;
      setSaveError(message);
      return message;
    } finally {
      setPending(false);
    }
  };

  const guard = useDraftGuard(dirty, saveDraft, discardDraft);
  const requestSwitch = (proceed: () => void): void => { guard.guardSwitch(proceed); };

  const createSet = async (): Promise<void> => {
    if (!isManager) return;
    try {
      const created = await createQuizSet(channelId, labels.newSet);
      setBaseline(created);
      setDraft(draftFromSet(created));
      setSelectedSetId(created.id);
      setSaved(false);
      setSaveError(undefined);
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch (error: unknown) {
      const code = quizErrorCode(error);
      setSaveError(code === "quiz_set_limit_reached" ? labels.maximumSets : labels.createError);
    }
  };

  const chooseSet = (setId: string): void => {
    if (setId === selectedSetId) return;
    requestSwitch(() => {
      setSelectedSetId(setId);
      setSaved(false);
      setSaveError(undefined);
    });
  };

  const removeSet = async (): Promise<void> => {
    if (baseline === null) return;
    setPending(true);
    setDeleteError(undefined);
    try {
      await deleteQuizSet(channelId, baseline.id, baseline.revision);
      setDeleteOpen(false);
      setSelectedSetId(null);
      setBaseline(null);
      setDraft(null);
      await queryClient.invalidateQueries({ predicate: (query) => isQuizQuery(channelId, query) });
    } catch {
      setDeleteError(labels.deleteError);
    } finally {
      setPending(false);
    }
  };

  const reloadConflict = async (): Promise<void> => {
    const result = await detailQuery.refetch();
    if (result.data !== undefined) {
      setBaseline(result.data);
      setDraft(draftFromSet(result.data));
      setConflicted(false);
      setSaveError(undefined);
      setValidationCode(null);
    }
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
        disabled={!isManager || pending}
      />
      <div className="quiz-editor-validation" role={validationCode === null ? undefined : "alert"} aria-live="polite">
        {validationCode === null ? null : labels.validationError(validationCode)}
      </div>
      <div className="quiz-question-toolbar">
        <h2>{labels.questionCount(draft.questions.length)}</h2>
        <Button
          icon="add"
          variant="secondary"
          onClick={() => markDirty({ ...draft, questions: [...draft.questions, { text: "", options: ["", ""], correctIndex: 0, enabled: true }] })}
          disabled={!isManager || pending || draft.questions.length >= QUIZ_QUESTION_MAXIMUM_COUNT}
        >{labels.addQuestion}</Button>
      </div>
      <div className="quiz-question-list">
        {draft.questions.map((question, questionIndex) => (
          <section className="quiz-question" key={questionIndex} aria-label={labels.question(questionIndex + 1)}>
            <div className="quiz-question__heading">
              <h3>{labels.question(questionIndex + 1)}</h3>
              <div className="quiz-question__actions">
                <Button variant="subtle" icon="sortAscending" iconOnly ariaLabel={labels.moveUp(questionIndex + 1)} disabled={!isManager || pending || questionIndex === 0} onClick={() => reorderQuestion(questionIndex, -1)} />
                <Button variant="subtle" icon="sortDescending" iconOnly ariaLabel={labels.moveDown(questionIndex + 1)} disabled={!isManager || pending || questionIndex === draft.questions.length - 1} onClick={() => reorderQuestion(questionIndex, 1)} />
                <Button variant="subtle" icon="remove" iconOnly ariaLabel={labels.removeQuestion(questionIndex + 1)} disabled={!isManager || pending} onClick={() => {
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
              disabled={!isManager || pending}
            />
            <fieldset className="quiz-options">
              <legend>{labels.options}</legend>
              <div className="quiz-options__list">
                {question.options.map((option, optionIndex) => (
                  <div className="quiz-option-chip" key={optionIndex}>
                    <NativeRadio
                      name={`quiz-correct-${String(questionIndex)}`}
                      value={String(optionIndex)}
                      checked={question.correctIndex === optionIndex}
                      onChange={() => updateQuestion(questionIndex, (current) => ({ ...current, correctIndex: optionIndex }))}
                      ariaLabel={labels.correctAnswer(optionIndex + 1, questionIndex + 1)}
                      disabled={!isManager || pending}
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
                      disabled={!isManager || pending}
                      className="quiz-option-chip__field"
                    />
                    {question.options.length > 2 ? <Button
                      variant="subtle"
                      icon="remove"
                      iconOnly
                      ariaLabel={labels.removeOption(optionIndex + 1)}
                      disabled={!isManager || pending}
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
                disabled={!isManager || pending}
              >{labels.addOption}</Button> : null}
            </fieldset>
            <SwitchRow
              label={labels.enabled}
              checked={question.enabled}
              onChange={(enabled) => updateQuestion(questionIndex, (current) => ({ ...current, enabled }))}
              disabled={!isManager || pending}
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
      pending={pending}
      saved={saved}
      {...(saveError === undefined ? {} : { error: saveError })}
      invalid={validated !== null && !validated.ok}
      {...(validationCode === null ? {} : { invalidMessage: labels.validationError(validationCode) })}
      {...(conflicted ? { conflict: { message: labels.conflict, reloadLabel: labels.reload, onReload: () => { void reloadConflict(); } } } : {})}
      onSave={() => { void saveDraft(); }}
      onInvalidSave={() => {
        if (validated !== null && !validated.ok) setValidationCode(validated.code);
      }}
      onDiscard={discardDraft}
      saveLabel={labels.save}
      discardLabel={labels.discard}
      savedLabel={labels.saved}
      pendingLabel={labels.saving}
      saveDisabled={!isManager || baseline === null || pending}
      discardDisabled={!isManager || pending}
    />
  );

  const listToolbar = (
    <div className="quiz-collection-toolbar">
      <ListToolbar
        language={activeLanguage}
        searchLabel={labels.search}
        searchLabelVisible
        searchPlaceholder={labels.searchPlaceholder}
        searchClearLabel={labels.clearSearch}
        searchValue={search}
        onSearchChange={(value) => { setSearch(value); setPage(1); }}
        create={{
          label: labels.newSet,
          onClick: () => requestSwitch(() => { void createSet(); }),
          disabled: !isManager || pending || (search.trim().length === 0 && (data?.total ?? 0) >= QUIZ_SET_MAXIMUM_COUNT),
          ...(search.trim().length === 0 && (data?.total ?? 0) >= QUIZ_SET_MAXIMUM_COUNT ? { reason: labels.maximumSets } : {}),
        }}
      />
      <div className="quiz-collection-pagination" aria-label={labels.page(page, totalPages)}>
        <Button variant="subtle" icon="chevron-left" iconOnly ariaLabel={labels.previousPage} disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} />
        <span>{labels.page(page, totalPages)}</span>
        <Button variant="subtle" icon="chevron-right" iconOnly ariaLabel={labels.nextPage} disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} />
      </div>
    </div>
  );

  const setRows = data?.sets.map((set) => (
    <button
      className={`quiz-set-row${selectedSetId === set.id ? " is-selected" : ""}`}
      type="button"
      aria-pressed={selectedSetId === set.id}
      disabled={pending}
      key={set.id}
      onClick={() => chooseSet(set.id)}
    >
      <span className="quiz-set-row__name">{set.name}</span>
      <span className="quiz-set-row__count">{labels.questionCount(set.questionCount)}</span>
    </button>
  ));

  const selectedLoaded = detailQuery.data?.id === selectedSetId;
  const empty = data !== undefined && data.total === 0;
  const detail = selectedLoaded && questionEditor !== null ? (
    <section className="module-stack quiz-detail" aria-label={labels.title}>
      <div className="quiz-detail__toolbar">
        {baseline !== null && isManager ? <Button variant="subtle" icon="remove" disabled={pending} onClick={() => { setDeleteError(undefined); setDeleteOpen(true); }}>{labels.delete}</Button> : null}
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
      onCloseDetail={() => guard.guardSwitch(() => { setSelectedSetId(null); })}
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
      confirmLabel={labels.confirm}
      cancelLabel={labels.cancel}
      danger
      onConfirm={() => { void removeSet(); }}
      onCancel={() => { setDeleteOpen(false); }}
      pending={pending}
      {...(deleteError === undefined ? {} : { error: deleteError })}
    />
  </section>;
}
