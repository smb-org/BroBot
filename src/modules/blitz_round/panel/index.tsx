import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Badge, Button, ChipsInput, CollectionPage, ConfirmDialog, Field, Icon, PageHeader,
  SegmentChoice, SwitchSection, TemplateTextField, UnitInput, useDraft, useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { validateBlitzQuestion } from "../domain/questions";
import { blitzTexts } from "../locale";
import { BLITZ_QUESTION_PAGE_SIZE, blitzRoundSettingsSchema, type BlitzQuestion, type BlitzQuestionInput, type BlitzQuestionKind, type BlitzRoundSettings } from "../contracts";
import {
  blitzErrorCode, createBlitzQuestion, deleteBlitzQuestion, loadBlitzQuestions, loadBlitzSettings,
  saveBlitzSettings, updateBlitzQuestion,
} from "./service";
import { blitzTemplateMessages } from "./locale";
import { BLITZ_TEMPLATE_VARIABLES } from "../contracts/template-variables";
import "./panel.css";

const NEW_QUESTION = "__new_blitz_question__";

interface Draft {
  kind: BlitzQuestionKind;
  prompt: string;
  answers: string[];
  enabled: boolean;
}

const blankDraft = (): Draft => ({ kind: "scramble", prompt: "", answers: [], enabled: true });
const fromQuestion = (question: BlitzQuestion | null): Draft => question === null
  ? blankDraft()
  : { kind: question.kind, prompt: question.prompt, answers: [...question.answers], enabled: question.enabled };

const questionInput = (draft: Draft): BlitzQuestionInput | null => {
  const answers = draft.kind === "scramble" ? [draft.prompt.toLocaleUpperCase("de-DE")] : draft.answers;
  const checked = validateBlitzQuestion({ ...draft, answers });
  return checked.ok ? checked.value : null;
};

export default function BlitzRoundPanel(properties: ModulePanelProperties): ReactElement {
  return <BlitzRoundPanelContent key={properties.channelId} {...properties} />;
}

function BlitzRoundPanelContent({ channelId, language, canManage = true }: ModulePanelProperties): ReactElement {
  const labels = blitzTexts(language);
  const queryClient = useDashboardQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState<BlitzQuestion | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const switchRef = useRef<((proceed: () => void) => void) | null>(null);
  const questionsQuery = useModuleQuery(channelId, "blitz_round", `questions:${String(page)}:${search}`, (signal) => loadBlitzQuestions(channelId, page, search, signal));
  const settingsQuery = useModuleQuery(channelId, "blitz_round", "settings", (signal) => loadBlitzSettings(channelId, signal));
  const data = questionsQuery.data;
  const questions = data?.questions ?? [];
  const maxPage = Math.max(1, Math.ceil((data?.total ?? 0) / BLITZ_QUESTION_PAGE_SIZE));

  if (selectedId === null && data !== undefined) {
    const first = data.questions[0] ?? null;
    setSelectedId(first?.id ?? NEW_QUESTION);
    setSelectedQuestion(first);
  }

  const requestSwitch = (proceed: () => void): void => {
    if (switchRef.current === null) proceed();
    else switchRef.current(proceed);
  };

  const chooseQuestion = (question: BlitzQuestion): void => requestSwitch(() => {
    setShowSettings(false);
    setSelectedId(question.id);
    setSelectedQuestion(question);
    setDetailOpen(true);
  });

  const newQuestion = (): void => requestSwitch(() => {
    setSearch("");
    setPage(1);
    setShowSettings(false);
    setSelectedId(NEW_QUESTION);
    setSelectedQuestion(null);
    setDetailOpen(true);
  });

  const openSettings = (): void => { setShowSettings(true); setDetailOpen(true); };
  const closeSettings = (): void => requestSwitch(() => { setShowSettings(false); setDetailOpen(true); });

  const saveQuestion = useCallback(async (draft: Draft): Promise<BlitzQuestion | null> => {
    const input = questionInput(draft);
    if (input === null) return null;
    const saved = selectedId === NEW_QUESTION
      ? await createBlitzQuestion(channelId, input)
      : await updateBlitzQuestion(channelId, selectedId ?? "", input);
    await questionsQuery.refetch();
    return saved;
  }, [channelId, questionsQuery, selectedId]);

  const selectSavedQuestion = (saved: BlitzQuestion): void => {
    setSelectedId(saved.id);
    setSelectedQuestion(saved);
  };

  const onDeleted = async (): Promise<void> => {
    const deletingId = selectedId;
    if (deletingId === null || deletingId === NEW_QUESTION) return;
    await deleteBlitzQuestion(channelId, deletingId);
    const refreshed = await questionsQuery.refetch();
    const total = refreshed.data?.total ?? 0;
    const nextPage = Math.min(page, Math.max(1, Math.ceil(total / BLITZ_QUESTION_PAGE_SIZE)));
    const nextPageData = nextPage === page
      ? refreshed.data
      : await loadBlitzQuestions(channelId, nextPage, search);
    if (nextPage !== page && nextPageData !== undefined) {
      queryClient.setQueryData(moduleQueryKey(channelId, "blitz_round", `questions:${String(nextPage)}:${search}`), nextPageData);
      setPage(nextPage);
    }
    const next = nextPageData?.questions[0] ?? null;
    setSelectedId(next?.id ?? NEW_QUESTION);
    setSelectedQuestion(next);
    setShowSettings(false);
  };

  const toolbar = <div className="blitz-panel__toolbar">
    <div className="blitz-panel__toolbar-top">
      <Field variant="search" label={labels.search} clearLabel={labels.clearSearch} value={search} onChange={(value) => { setSearch(value); setPage(1); }} placeholder={labels.searchPlaceholder} />
      <Button variant="primary" icon="add" disabled={!canManage} onClick={newQuestion}>{labels.addQuestion}</Button>
    </div>
    <div className="blitz-panel__pagination" aria-label={labels.questions}>
      <Button size="compact" icon="collapse" iconOnly ariaLabel={labels.previousPage} disabled={page <= 1} onClick={() => { setPage((current) => Math.max(1, current - 1)); }} />
      <span>{labels.pageCount(page, maxPage)}</span>
      <Button size="compact" disabled={page >= maxPage} onClick={() => { setPage((current) => Math.min(maxPage, current + 1)); }}>{labels.nextPage}</Button>
      <span className="blitz-panel__count">{labels.questionCount(data?.total ?? 0)}</span>
    </div>
  </div>;

  const list = questionsQuery.isPending && data === undefined
    ? <div className="blitz-panel__list-placeholder" aria-hidden="true"><span /><span /><span /><span /></div>
    : questionsQuery.isError && data === undefined
      ? <div className="blitz-panel__empty"><p>{labels.loadError}</p><Button onClick={() => { void questionsQuery.refetch(); }}>{labels.retry}</Button></div>
      : questions.length === 0
        ? <div className="blitz-panel__empty"><p>{labels.emptyHint}</p></div>
        : <div className="blitz-panel__list">
          {questions.map((question) => <button
            key={question.id}
            type="button"
            className={`blitz-panel__row${selectedId === question.id && !showSettings ? " blitz-panel__row--selected" : ""}${question.enabled ? "" : " blitz-panel__row--disabled"}`}
            aria-current={selectedId === question.id && !showSettings ? "true" : undefined}
            onClick={() => chooseQuestion(question)}
          >
            <span className={`blitz-panel__indicator${question.enabled ? " blitz-panel__indicator--on" : ""}`} aria-hidden="true" />
            <span className="blitz-panel__row-copy">
              <span className="blitz-panel__row-heading"><Badge tone="neutral">{question.kind === "scramble" ? labels.scramble : labels.quiz}</Badge><strong>{question.prompt}</strong></span>
              <small>{question.kind === "scramble" ? question.prompt : question.answers[0] ?? ""}</small>
            </span>
          </button>)}
        </div>;

  const currentQuestion = selectedQuestion?.id === selectedId
    ? selectedQuestion
    : questions.find((question) => question.id === selectedId) ?? null;
  const detail = showSettings
    ? settingsQuery.data === undefined
      ? <div className="blitz-panel__settings-loading" aria-live="polite">{settingsQuery.isError ? labels.loadError : labels.saving}</div>
      : <SettingsEditor channelId={channelId} language={language === "en" ? "en" : "de"} settings={settingsQuery.data.settings} revision={settingsQuery.data.revision} canManage={canManage} onBack={closeSettings} registerSwitch={(switcher) => { switchRef.current = switcher; }} onSaved={(settings, revision) => {
        queryClient.setQueryData(moduleQueryKey(channelId, "blitz_round", "settings"), { settings, revision });
      }} />
    : selectedId === null
      ? <div className="blitz-panel__placeholder"><PageHeader title={labels.title} subtitle={labels.noSelection} /></div>
      : <QuestionEditor
        key={selectedId}
        question={currentQuestion}
        isNew={selectedId === NEW_QUESTION}
        language={language === "en" ? "en" : "de"}
        canManage={canManage}
        onSave={saveQuestion}
        onSaved={selectSavedQuestion}
        onDelete={onDeleted}
        onOpenSettings={openSettings}
        registerSwitch={(switcher) => { switchRef.current = switcher; }}
      />;

  return <div className="blitz-panel">
    <CollectionPage
      title={labels.title}
      headerKind="blitz"
      subtitle={labels.subtitle}
      toolbar={toolbar}
      list={list}
      detail={detail}
      detailOpen={detailOpen}
      backLabel={labels.back}
      onCloseDetail={() => { requestSwitch(() => { setDetailOpen(false); }); }}
    />
  </div>;
}

function QuestionEditor({ question, isNew, language, canManage, onSave, onSaved, onDelete, onOpenSettings, registerSwitch }: {
  question: BlitzQuestion | null;
  isNew: boolean;
  language: "de" | "en";
  canManage: boolean;
  onSave: (draft: Draft) => Promise<BlitzQuestion | null>;
  onSaved: (question: BlitzQuestion) => void;
  onDelete: () => Promise<void>;
  onOpenSettings: () => void;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
}): ReactElement {
  const labels = blitzTexts(language);
  const draft = useDraft(fromQuestion(question));
  const [pendingAnswer, setPendingAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [attempted, setAttempted] = useState(false);
  const validation = validateBlitzQuestion({
    ...draft.value,
    answers: draft.value.kind === "scramble" ? [draft.value.prompt] : draft.value.answers,
  });
  const input = questionInput(draft.value);
  const invalid = input === null || (draft.value.kind === "quiz" && pendingAnswer.trim().length > 0);
  const reset = (): void => { draft.reset(); setPendingAnswer(""); setSaveError(undefined); setAttempted(false); };
  const saveRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));
  const guard = useDraftGuard(draft.dirty || pendingAnswer.trim().length > 0, () => saveRef.current(), reset);
  const { guardSwitch } = guard;

  const save = async (): Promise<string | null> => {
    setAttempted(true);
    setSaveError(undefined);
    if (!canManage) return labels.roleLocked;
    if (pendingAnswer.trim().length > 0) {
      setSaveError(labels.invalidAnswer);
      return labels.invalidAnswer;
    }
    if (!validation.ok) {
      const message = labels.validationError(validation.code);
      setSaveError(message);
      return message;
    }
    setSaving(true);
    try {
      const saved = await onSave(draft.value);
      if (saved === null) {
        setSaveError(labels.saveError);
        return labels.saveError;
      }
      draft.accept(fromQuestion(saved));
      setPendingAnswer("");
      setAttempted(false);
      guard.completeSwitch();
      onSaved(saved);
      return null;
    } catch (failure: unknown) {
      const code = blitzErrorCode(failure);
      const message = code === "question_limit_reached" ? labels.questionLimit : labels.saveError;
      setSaveError(message);
      return message;
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    registerSwitch(guardSwitch);
    return () => { registerSwitch(null); };
  }, [guardSwitch, registerSwitch]);

  const typeOptions = [
    { value: "scramble" as const, label: labels.scramble },
    { value: "quiz" as const, label: labels.quiz },
  ];
  const localError = attempted && !validation.ok ? labels.validationError(validation.code) : undefined;
  const saveProps = {
    dirty: draft.dirty || pendingAnswer.trim().length > 0,
    persistent: true,
    pending: saving,
    ...(saveError === undefined ? {} : { error: saveError }),
    invalid,
    invalidMessage: labels.invalidAnswer,
    onSave: () => { void save(); },
    onInvalidSave: () => { setAttempted(true); },
    onDiscard: reset,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
  };

  return <div className="blitz-panel__detail">
    <PageHeader
      kind="blitz"
      title={isNew ? labels.newQuestion : question?.prompt ?? labels.title}
      badges={<Badge tone="neutral">{draft.value.kind === "scramble" ? labels.scramble : labels.quiz}</Badge>}
      pageActions={<Button variant="neutral" icon="tabSettings" onClick={() => { guard.guardSwitch(onOpenSettings); }}>{labels.settings}</Button>}
      {...(isNew ? {} : { overflow: <Button variant="subtle" danger="subtle" size="compact" onClick={() => { guard.guardSwitch(() => { setDeleteError(undefined); setDeleteOpen(true); }); }}><Icon name="remove" size={16} />{labels.delete}</Button> })}
      save={saveProps}
    />
    <div className="blitz-panel__editor">
      <SegmentChoice
        label={labels.type}
        value={draft.value.kind}
        options={typeOptions}
        disabled={!canManage || saving}
        onChange={(kind) => { draft.setValue((current) => ({ ...current, kind, answers: kind === "scramble" ? [] : current.answers })); setPendingAnswer(""); setAttempted(false); }}
        reserveError
      />
      <Field
        label={draft.value.kind === "scramble" ? labels.word : labels.prompt}
        value={draft.value.prompt}
        onChange={(prompt) => { draft.setValue((current) => ({ ...current, prompt })); setAttempted(false); }}
        disabled={!canManage || saving}
        maxLength={draft.value.kind === "scramble" ? 16 : 120}
        countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
        {...(localError === undefined ? {} : { error: localError })}
      />
      <div className="blitz-panel__answers">{draft.value.kind === "quiz" ? <ChipsInput
        label={labels.acceptedAnswers}
        listLabel={labels.acceptedAnswers}
        values={draft.value.answers}
        pending={pendingAnswer}
        onPendingChange={setPendingAnswer}
        onChange={(answers) => { if (draft.value.kind === "quiz") draft.setValue((current) => ({ ...current, answers })); }}
        placeholder={labels.answerPlaceholder}
        disabled={!canManage || saving}
        max={10}
        separator="comma"
        removeLabel={labels.removeAnswer}
        validate={(answer) => answer.length > 60 ? labels.validationError("answer_invalid") : null}
        messages={{
          countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
          atLimitHint: labels.validationError("answer_count_invalid"),
          duplicateWarning: (answer) => labels.duplicateAnswer(answer),
        }}
        {...(attempted && !validation.ok && validation.code === "answer_count_invalid"
          ? { error: labels.validationError("answer_count_invalid") }
          : {})}
      /> : null}</div>
      <SwitchSection
        title={labels.enabled}
        checked={draft.value.enabled}
        onChange={(enabled) => { draft.setValue((current) => ({ ...current, enabled })); }}
        hint={labels.enabledHint}
        disabled={!canManage || saving}
      />
      <div className="blitz-panel__error-slot" role="status" aria-live="polite">{saveError ?? "\u00a0"}</div>
    </div>
    <ConfirmDialog
      opened={deleteOpen}
      title={labels.deleteTitle}
      description={labels.deleteConfirm}
      confirmLabel={labels.delete}
      cancelLabel={labels.cancel}
      danger
      {...(deleteError === undefined ? {} : { error: deleteError })}
      onCancel={() => { setDeleteOpen(false); }}
      onConfirm={() => { void onDelete().then(() => setDeleteOpen(false)).catch(() => setDeleteError(labels.deleteError)); }}
    />
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.unsavedTitle}
      description={labels.unsavedDescription}
      confirmLabel={labels.discard}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.save, onClick: () => { void guard.saveAndSwitch(); } }}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
      onCancel={guard.continueEditing}
      onConfirm={guard.discardAndSwitch}
    />
  </div>;
}

function SettingsEditor({ channelId, language, settings, revision, canManage, onBack, registerSwitch, onSaved }: {
  channelId: string;
  language: "de" | "en";
  settings: BlitzRoundSettings;
  revision: number;
  canManage: boolean;
  onBack: () => void;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
  onSaved: (settings: BlitzRoundSettings, revision: number) => void;
}): ReactElement {
  const labels = blitzTexts(language);
  const queryClient = useDashboardQueryClient();
  const draft = useDraft(settings);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const parsed = blitzRoundSettingsSchema.safeParse(draft.value);
  const valid = parsed.success;

  const reset = (): void => { draft.reset(); setError(undefined); setSaved(false); };

  const save = async (): Promise<string | null> => {
    if (!canManage || !valid) return labels.settingsError;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await runModuleQueryWrite(queryClient, channelId, "blitz_round", "settings", () => saveBlitzSettings(channelId, currentRevision, draft.value), {
        baselineRevision: currentRevision,
        updateCache: (_current, next) => next,
      });
      draft.accept(result.settings);
      setCurrentRevision(result.revision);
      onSaved(result.settings, result.revision);
      setSaved(true);
      return null;
    } catch {
      setError(labels.settingsError);
      return labels.settingsError;
    } finally {
      setSaving(false);
    }
  };

  const saveProps = {
    dirty: draft.dirty,
    persistent: true,
    pending: saving,
    saved,
    ...(error === undefined ? {} : { error }),
    invalid: !valid,
    invalidMessage: labels.settingsError,
    onSave: () => { void save(); },
    onDiscard: draft.reset,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
  };
  const guard = useDraftGuard(draft.dirty, save, reset);
  const { guardSwitch } = guard;
  useEffect(() => {
    registerSwitch(guardSwitch);
    return () => { registerSwitch(null); };
  }, [guardSwitch, registerSwitch]);

  return <div className="blitz-panel__detail blitz-panel__settings">
    <PageHeader kind="blitz" title={labels.settingsSection} pageActions={<Button variant="neutral" icon="collapse" onClick={() => { guard.guardSwitch(onBack); }}>{labels.back}</Button>} save={saveProps} />
    <div className="blitz-panel__settings-form">
      <div className="blitz-panel__settings-grid">
        <UnitInput label={labels.prize} value={draft.value.prize} min={1} max={10_000} disabled={!canManage || saving} onChange={(value) => { if (typeof value === "number") draft.setValue((current) => ({ ...current, prize: value })); }} />
        <UnitInput label={labels.answerTime} unit={labels.secondsUnit} value={draft.value.answerTimeSeconds} min={15} max={300} disabled={!canManage || saving} onChange={(value) => { if (typeof value === "number") draft.setValue((current) => ({ ...current, answerTimeSeconds: value })); }} />
        <SegmentChoice
          label={labels.chatTarget}
          value={draft.value.chatTarget ?? "channel_default"}
          options={[
            { value: "channel_default", label: labels.channelDefault },
            { value: "all_chats", label: labels.allChats },
            { value: "source_only", label: labels.sourceOnly },
            { value: "where_asked", label: labels.whereAsked },
          ]}
          disabled={!canManage || saving}
          onChange={(value) => { draft.setValue((current) => ({ ...current, chatTarget: value === "channel_default" ? null : value })); }}
          reserveError
        />
      </div>
      <SwitchSection title={labels.autoStart} checked={draft.value.autoStart} onChange={(autoStart) => { draft.setValue((current) => ({ ...current, autoStart })); }} hint={labels.autoStartHint} disabled={!canManage || saving} />
      <UnitInput label={labels.autoStartInterval} unit={labels.minutesUnit} value={draft.value.autoStartIntervalMinutes} min={15} max={240} disabled={!canManage || saving || !draft.value.autoStart} onChange={(value) => { if (typeof value === "number") draft.setValue((current) => ({ ...current, autoStartIntervalMinutes: value })); }} />
      <TemplateSetting language={language} label={labels.startText} value={draft.value.startText} onChange={(startText) => { draft.setValue((current) => ({ ...current, startText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
      <TemplateSetting language={language} label={labels.solvedText} value={draft.value.solvedText} onChange={(solvedText) => { draft.setValue((current) => ({ ...current, solvedText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
      <TemplateSetting language={language} label={labels.timeoutText} value={draft.value.timeoutText} onChange={(timeoutText) => { draft.setValue((current) => ({ ...current, timeoutText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
      <div className="blitz-panel__error-slot" role="status" aria-live="polite">{error ?? "\u00a0"}</div>
    </div>
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.unsavedTitle}
      description={labels.settingsUnsavedDescription}
      confirmLabel={labels.discard}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.save, onClick: () => { void guard.saveAndSwitch(); } }}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
      onCancel={guard.continueEditing}
      onConfirm={guard.discardAndSwitch}
    />
  </div>;
}

function TemplateSetting({ label, value, onChange, disabled, hint, language }: { label: string; value: string; onChange: (value: string) => void; disabled: boolean; hint: string; language: "de" | "en" }): ReactElement {
  return <TemplateTextField label={label} value={value} onChange={onChange} disabled={disabled} hint={hint}
    maxLength={500} minRows={2} messages={blitzTemplateMessages[language]}
    variables={BLITZ_TEMPLATE_VARIABLES.map((variable) => ({
      name: variable.name, sample: variable.sample,
      label: variable.picker?.[language].label ?? variable.name,
      description: variable.picker?.[language].description ?? variable.name,
    }))} />;
}
