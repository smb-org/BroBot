import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import {
  Button,
  ConfirmDialog,
  Field,
  NativeRadio,
  SwitchRow,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { SaveStatusProps } from "../../../dashboard/ui/SaveStatus";
import {
  QUIZ_OPTION_MAXIMUM_COUNT,
  QUIZ_OPTION_MAXIMUM_LENGTH,
  QUIZ_QUESTION_MAXIMUM_COUNT,
  QUIZ_QUESTION_TEXT_MAXIMUM_LENGTH,
  type QuizSet,
  type QuizSetInput,
} from "../contracts";
import { validateQuizSet } from "../domain/sets";
import { quizPanelTexts } from "../locale";
import { quizErrorCode, saveQuizSet } from "./service";
import "./panel.css";

export interface QuizEditorControl {
  session: symbol;
  guardSwitch: (proceed: () => void) => void;
  isDirty: () => boolean;
}

interface QuizSetEditorProperties {
  channelId: string;
  language: "de" | "en";
  canManage: boolean;
  deleting: boolean;
  set: QuizSet;
  createError?: string;
  onRegisterEditor: (editor: QuizEditorControl) => () => void;
  onSaveStatus: (session: symbol, status: SaveStatusProps) => void;
  onClearCreateError: () => void;
  onDelete: (set: QuizSet, revision: number, session: symbol) => void;
}

const draftFromSet = (set: QuizSet): QuizSetInput => ({
  name: set.name,
  questions: set.questions.map(({ text, options, correctIndex, enabled }) => ({ text, options: [...options], correctIndex, enabled })),
});

const characterCount = (value: string): number => Array.from(value).length;

export default function QuizSetEditor({ channelId, language, canManage, deleting, set, createError, onRegisterEditor, onSaveStatus, onClearCreateError, onDelete }: QuizSetEditorProperties): ReactElement {
  const labels = useMemo(() => quizPanelTexts(language), [language]);
  const queryClient = useDashboardQueryClient();
  const setId = set.id;
  const setRevision = set.revision;
  const initialDraft = useMemo(() => draftFromSet(set), [set]);
  const setDraft = initialDraft;
  const draft = useDraft(initialDraft);
  const { value: draftValue, setValue: setDraftValue, dirty: draftDirty, reset: resetDraft, accept: acceptDraft, advanceBaseline } = draft;
  const draftRef = useRef(draftValue);
  const baselineDraftRef = useRef(initialDraft);
  const dirtyRef = useRef(draftDirty);
  const [session] = useState(() => Symbol());
  const mounted = useRef(false);
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const [baselineRevision, setBaselineRevision] = useState(setRevision);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [validationCode, setValidationCode] = useState<Parameters<typeof labels.validationError>[0] | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const validated = useMemo(() => validateQuizSet(draftValue), [draftValue]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (setRevision <= baselineRevision || draftDirty || saving || conflicted) return;
    const nextDraft = setDraft;
    draftRef.current = nextDraft;
    baselineDraftRef.current = nextDraft;
    dirtyRef.current = false;
    acceptDraft(nextDraft);
    // Query refreshes are external server state that may replace a clean local baseline.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBaselineRevision(setRevision);
    setValidationCode(null);
    setSaveError(undefined);
    setConflicted(false);
  }, [acceptDraft, baselineRevision, conflicted, draftDirty, saving, setDraft, setRevision]);

  const discardDraft = useCallback((): void => {
    draftRef.current = baselineDraftRef.current;
    dirtyRef.current = false;
    resetDraft();
    setValidationCode(null);
    setSaveError(undefined);
    setSaved(false);
  }, [resetDraft]);

  const saveDraft = useCallback((): Promise<string | null> => {
    if (saveInFlight.current !== null) return saveInFlight.current;
    if (!canManage) return Promise.resolve(labels.saveError);
    if (!validated.ok) {
      setValidationCode(validated.code);
      return Promise.resolve(labels.validationError(validated.code));
    }

    const revision = baselineRevision;
    setSaving(true);
    setSaveError(undefined);
    setConflicted(false);
    onClearCreateError();
    const operation = (async (): Promise<string | null> => {
      try {
        const savedSet = await runModuleQueryWrite(
          queryClient,
          channelId,
          "quiz",
          `set:${setId}`,
          (currentRevision) => saveQuizSet(channelId, setId, currentRevision ?? revision, validated.value),
          { baselineRevision: revision, updateCache: (_current, result) => result },
        );
        const committedDraft = draftFromSet(savedSet);
        const changedWhileSaving = JSON.stringify(draftRef.current) !== JSON.stringify(committedDraft);
        if (mounted.current) {
          baselineDraftRef.current = committedDraft;
          dirtyRef.current = changedWhileSaving;
          if (changedWhileSaving) advanceBaseline(committedDraft);
          else {
            draftRef.current = committedDraft;
            acceptDraft(committedDraft);
          }
          setBaselineRevision(savedSet.revision);
          setSaved(!changedWhileSaving);
          setValidationCode(null);
          setSaveError(undefined);
          setConflicted(false);
        }
        await queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === "channel" && query.queryKey[1] === channelId &&
            query.queryKey[2] === "module" && query.queryKey[3] === "quiz" &&
            typeof query.queryKey[4] === "string" && query.queryKey[4].startsWith("sets:"),
        });
        const hasUnsavedEdits = JSON.stringify(draftRef.current) !== JSON.stringify(committedDraft);
        return hasUnsavedEdits ? labels.draftChangedWhileSaving : null;
      } catch (failure: unknown) {
        const code = quizErrorCode(failure);
        const message = code === "quiz_set_conflict" || code === "quiz_set_deleted" || code === "quiz_set_not_found"
          ? labels.conflict
          : labels.saveError;
        if (mounted.current) {
          setConflicted(code === "quiz_set_conflict" || code === "quiz_set_deleted" || code === "quiz_set_not_found");
          setSaveError(message);
        }
        return message;
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
    saveInFlight.current = operation;
    return operation.finally(() => {
      if (saveInFlight.current === operation) saveInFlight.current = null;
    });
  }, [acceptDraft, advanceBaseline, baselineRevision, canManage, channelId, labels, onClearCreateError, queryClient, setId, validated]);

  const reloadConflict = useCallback(async (): Promise<void> => {
    const valueAtStart = JSON.stringify(draftRef.current);
    setReloading(true);
    try {
      const reloaded = await refetchModuleQueryData<QuizSet>(queryClient, channelId, "quiz", `set:${setId}`);
      if (!mounted.current || JSON.stringify(draftRef.current) !== valueAtStart) return;
      const nextDraft = draftFromSet(reloaded);
      draftRef.current = nextDraft;
      baselineDraftRef.current = nextDraft;
      dirtyRef.current = false;
      acceptDraft(nextDraft);
      setBaselineRevision(reloaded.revision);
      setConflicted(false);
      setSaveError(undefined);
      setValidationCode(null);
      setSaved(false);
    } catch {
      // Keep both the local draft and conflict state when the reload fails.
    } finally {
      if (mounted.current) setReloading(false);
    }
  }, [acceptDraft, channelId, queryClient, setId]);

  const guard = useDraftGuard(draftDirty, saveDraft, discardDraft);
  const isDirty = useCallback(() => dirtyRef.current, []);
  const control = useMemo<QuizEditorControl>(() => ({
    session,
    guardSwitch: guard.guardSwitch,
    isDirty,
  }), [guard.guardSwitch, isDirty, session]);

  useEffect(() => onRegisterEditor(control), [control, onRegisterEditor]);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);

  const statusProps = useMemo<SaveStatusProps>(() => ({
    persistent: true,
    dirty: draftDirty,
    pending: saving,
    saved,
    ...((saveError ?? createError) === undefined ? {} : { error: saveError ?? createError }),
    invalid: !validated.ok,
    ...(validationCode === null ? {} : { invalidMessage: labels.validationError(validationCode) }),
    ...(conflicted ? {
      conflict: {
        message: labels.conflict,
        reloadLabel: reloading ? labels.reloading : labels.reload,
        reloadPending: reloading,
        onReload: () => { void reloadConflict(); },
      },
    } : {}),
    onSave: () => { void saveDraft(); },
    onInvalidSave: () => {
      if (!validated.ok) setValidationCode(validated.code);
    },
    onDiscard: discardDraft,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
    saveDisabled: !canManage,
    discardDisabled: !canManage,
  }), [canManage, conflicted, createError, discardDraft, draftDirty, labels, reloadConflict, reloading, saveDraft, saveError, saved, saving, validated, validationCode]);

  useEffect(() => { onSaveStatus(session, statusProps); }, [onSaveStatus, session, statusProps]);

  const changeDraft = (next: QuizSetInput): void => {
    draftRef.current = next;
    dirtyRef.current = JSON.stringify(next) !== JSON.stringify(baselineDraftRef.current);
    setDraftValue(next);
    setSaved(false);
    setSaveError(undefined);
    setValidationCode(null);
    onClearCreateError();
  };

  const updateQuestion = (index: number, change: (question: QuizSetInput["questions"][number]) => QuizSetInput["questions"][number]): void => {
    const questions = draftValue.questions.map((question, current) => current === index ? change(question) : question);
    changeDraft({ ...draftValue, questions });
  };

  const reorderQuestion = (index: number, direction: -1 | 1): void => {
    const targetIndex = index + direction;
    const current = draftValue.questions[index];
    const target = draftValue.questions[targetIndex];
    if (current === undefined || target === undefined) return;
    const questions = [...draftValue.questions];
    questions[index] = target;
    questions[targetIndex] = current;
    changeDraft({ ...draftValue, questions });
  };

  return <>
    <section className="module-stack quiz-detail" aria-label={labels.title}>
      <div className="quiz-detail__toolbar">
        {canManage ? <Button variant="subtle" icon="remove" disabled={deleting} onClick={() => onDelete(set, baselineRevision, session)}>{deleting ? labels.deleting : labels.delete}</Button> : null}
      </div>
      <div className="quiz-editor-content">
        <Field
          label={labels.setName}
          value={draftValue.name}
          onChange={(name) => { changeDraft({ ...draftValue, name }); }}
          placeholder={labels.setNamePlaceholder}
          disabled={!canManage}
          errorInDescription
          {...(validationCode === "set_name_required" ? { error: labels.validationError(validationCode) } : {})}
        />
        <div className="quiz-question-toolbar">
          <h2>{labels.questionCount(draftValue.questions.length)}</h2>
          <Button
            icon="add"
            variant="secondary"
            onClick={() => changeDraft({ ...draftValue, questions: [...draftValue.questions, { text: "", options: ["", ""], correctIndex: 0, enabled: true }] })}
            disabled={!canManage || draftValue.questions.length >= QUIZ_QUESTION_MAXIMUM_COUNT}
          >{labels.addQuestion}</Button>
        </div>
        <div className="quiz-question-list">
          {draftValue.questions.map((question, questionIndex) => (
            <section className="quiz-question" key={questionIndex} aria-label={labels.question(questionIndex + 1)}>
              <div className="quiz-question__heading">
                <h3>{labels.question(questionIndex + 1)}</h3>
                <div className="quiz-question__actions">
                  <Button variant="subtle" icon="sortAscending" iconOnly ariaLabel={labels.moveUp(questionIndex + 1)} disabled={!canManage || questionIndex === 0} onClick={() => reorderQuestion(questionIndex, -1)} />
                  <Button variant="subtle" icon="sortDescending" iconOnly ariaLabel={labels.moveDown(questionIndex + 1)} disabled={!canManage || questionIndex === draftValue.questions.length - 1} onClick={() => reorderQuestion(questionIndex, 1)} />
                  <Button variant="subtle" icon="remove" iconOnly ariaLabel={labels.removeQuestion(questionIndex + 1)} disabled={!canManage} onClick={() => {
                    changeDraft({ ...draftValue, questions: draftValue.questions.filter((_, index) => index !== questionIndex) });
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
                disabled={!canManage}
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
                        disabled={!canManage}
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
                        disabled={!canManage}
                        className="quiz-option-chip__field"
                        errorInDescription
                        {...(validationCode === "option_invalid" && option.trim().length === 0 ? { error: labels.optionRequired } : {})}
                      />
                      {question.options.length > 2 ? <Button
                        variant="subtle"
                        icon="remove"
                        iconOnly
                        ariaLabel={labels.removeOption(optionIndex + 1)}
                        disabled={!canManage}
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
                  disabled={!canManage}
                >{labels.addOption}</Button> : null}
              </fieldset>
              <SwitchRow
                label={labels.enabled}
                checked={question.enabled}
                onChange={(enabled) => updateQuestion(questionIndex, (current) => ({ ...current, enabled }))}
                disabled={!canManage}
              />
            </section>
          ))}
        </div>
      </div>
    </section>
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
  </>;
}
