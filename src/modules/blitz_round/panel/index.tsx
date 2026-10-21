import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  Badge, Button, ChipsInput, CollectionPage, ConfirmDialog, Field, Icon, PageHeader,
  registerDashboardNavigationGuard, SegmentChoice, SwitchSection, TemplateTextField, UnitInput, useDraft, useDraftGuard,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { validateBlitzQuestion } from "../domain/questions";
import { normalizeBlitzAnswer } from "../domain/round";
import { blitzTexts } from "../locale";
import { BLITZ_QUESTION_PAGE_SIZE, blitzRoundSettingsSchema, type BlitzQuestion, type BlitzQuestionInput, type BlitzQuestionKind, type BlitzQuestionPage, type BlitzRoundSettings } from "../contracts";
import {
  blitzErrorCode, createBlitzQuestion, deleteBlitzQuestion, loadBlitzQuestion, loadBlitzQuestions, loadBlitzSettings,
  saveBlitzSettings, updateBlitzQuestion,
} from "./service";
import { blitzTemplateMessages } from "./locale";
import { BLITZ_TEMPLATE_VARIABLES } from "../contracts/template-variables";
import "./panel.css";

const NEW_QUESTION = "__new_blitz_question__";
type DashboardQueryClient = ReturnType<typeof useDashboardQueryClient>;
const EMPTY_DELETED_QUESTION_IDS: ReadonlySet<string> = new Set();
const deletedQuestionIdsByChannel = new Map<string, ReadonlySet<string>>();
const deletedQuestionIdSubscribers = new Map<string, Set<() => void>>();

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

const isQuestionListQuery = (channelId: string, query: { queryKey: readonly unknown[] }): boolean =>
  query.queryKey[0] === "channel" && query.queryKey[1] === channelId && query.queryKey[2] === "module" &&
  query.queryKey[3] === "blitz_round" && typeof query.queryKey[4] === "string" && query.queryKey[4].startsWith("questions:");

const getDeletedQuestionIds = (channelId: string): ReadonlySet<string> => deletedQuestionIdsByChannel.get(channelId) ?? EMPTY_DELETED_QUESTION_IDS;

const subscribeToDeletedQuestionIds = (channelId: string, subscriber: () => void): (() => void) => {
  let subscribers = deletedQuestionIdSubscribers.get(channelId);
  if (subscribers === undefined) {
    subscribers = new Set();
    deletedQuestionIdSubscribers.set(channelId, subscribers);
  }
  subscribers.add(subscriber);
  const channelSubscribers = subscribers;
  return () => {
    channelSubscribers.delete(subscriber);
    if (channelSubscribers.size === 0) deletedQuestionIdSubscribers.delete(channelId);
  };
};

const updateDeletedQuestionIds = (channelId: string, next: ReadonlySet<string>): void => {
  const current = getDeletedQuestionIds(channelId);
  if (next.size === current.size && [...next].every((questionId) => current.has(questionId))) return;
  if (next.size === 0) deletedQuestionIdsByChannel.delete(channelId);
  else deletedQuestionIdsByChannel.set(channelId, new Set(next));
  deletedQuestionIdSubscribers.get(channelId)?.forEach((subscriber) => subscriber());
};

const recordDeletedQuestion = (channelId: string, questionId: string): void => {
  updateDeletedQuestionIds(channelId, new Set([...getDeletedQuestionIds(channelId), questionId]));
};

const reconcileDeletedQuestions = (channelId: string, fetchedQuestions: readonly BlitzQuestion[]): void => {
  const fetchedIds = new Set(fetchedQuestions.map((question) => question.id));
  const remaining = new Set([...getDeletedQuestionIds(channelId)].filter((questionId) => fetchedIds.has(questionId)));
  updateDeletedQuestionIds(channelId, remaining);
};

const questionListSearch = (query: { queryKey: readonly unknown[] }): string | null => {
  const listKey = query.queryKey[4];
  if (typeof listKey !== "string" || !listKey.startsWith("questions:")) return null;
  const searchSeparator = listKey.indexOf(":", "questions:".length);
  return searchSeparator === -1 ? null : listKey.slice(searchSeparator + 1);
};

const questionListPage = (query: { queryKey: readonly unknown[] }): number => {
  const listKey = query.queryKey[4];
  if (typeof listKey !== "string" || !listKey.startsWith("questions:")) return Number.MAX_SAFE_INTEGER;
  const searchSeparator = listKey.indexOf(":", "questions:".length);
  return Number(listKey.slice("questions:".length, searchSeparator === -1 ? undefined : searchSeparator));
};

const lastKnownQuestionTotal = (channelId: string, search: string, queryClient: DashboardQueryClient): number | undefined => {
  let newestTotal: number | undefined;
  let newestTimestamp = -1;
  queryClient.getQueryCache().findAll({ predicate: (query) => isQuestionListQuery(channelId, query) && questionListSearch(query) === search })
    .forEach((query) => {
      const data = query.state.data as BlitzQuestionPage | undefined;
      if (data === undefined || !Array.isArray(data.questions) || typeof data.total !== "number") return;
      if (query.state.dataUpdatedAt < newestTimestamp) return;
      newestTotal = data.total;
      newestTimestamp = query.state.dataUpdatedAt;
    });
  return newestTotal;
};

const firstRemainingQuestion = (channelId: string, search: string, queryClient: DashboardQueryClient, excludedIds: ReadonlySet<string>): BlitzQuestion | null => {
  const cachedLists = queryClient.getQueryCache().findAll({ predicate: (query) => isQuestionListQuery(channelId, query) && questionListSearch(query) === search });
  cachedLists.sort((left, right) => questionListPage(left) - questionListPage(right));
  for (const query of cachedLists) {
    const data = query.state.data as BlitzQuestionPage | undefined;
    const question = data?.questions.find((candidate) => !excludedIds.has(candidate.id));
    if (question !== undefined) return question;
  }
  return null;
};

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
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const [newQuestionSession, setNewQuestionSession] = useState(0);
  const [selectedQuestion, setSelectedQuestion] = useState<BlitzQuestion | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<{ questionId: string; opened: boolean } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [deleteFailure, setDeleteFailure] = useState<"conflict" | "deleted" | null>(null);
  const subscribeToDeletedIds = useCallback((subscriber: () => void) => subscribeToDeletedQuestionIds(channelId, subscriber), [channelId]);
  const readDeletedIds = useCallback(() => getDeletedQuestionIds(channelId), [channelId]);
  const deletedQuestionIds = useSyncExternalStore(subscribeToDeletedIds, readDeletedIds, () => EMPTY_DELETED_QUESTION_IDS);
  const pendingDeleteSelection = useRef<string | null>(null);
  const switchRef = useRef<((proceed: () => void) => void) | null>(null);
  const pageQuery = useModuleQuery(channelId, "blitz_round", `questions:${String(page)}:${search}`, (signal) => loadBlitzQuestions(channelId, page, search, signal));
  const knownTotal = pageQuery.data?.total ?? lastKnownQuestionTotal(channelId, search, queryClient);
  const maxPage = knownTotal === undefined ? undefined : Math.max(1, Math.ceil(knownTotal / BLITZ_QUESTION_PAGE_SIZE));
  const effectivePage = maxPage === undefined ? page : Math.min(page, maxPage);
  const questionsQuery = useModuleQuery(channelId, "blitz_round", `questions:${String(effectivePage)}:${search}`, (signal) => loadBlitzQuestions(channelId, effectivePage, search, signal));
  const settingsQuery = useModuleQuery(channelId, "blitz_round", "settings", (signal) => loadBlitzSettings(channelId, signal));
  const data = questionsQuery.data;
  const questions = (data?.questions ?? []).filter((question) => !deletedQuestionIds.has(question.id));

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
      if (!isQuestionListQuery(channelId, event.query) || questionListSearch(event.query) !== search) return;
      const refreshed = event.query.state.data as BlitzQuestionPage | undefined;
      if (!Array.isArray(refreshed?.questions)) return;

      const excludedIds = getDeletedQuestionIds(channelId);
      if (selectedId !== null && excludedIds.has(selectedId) && !refreshed.questions.some((question) => question.id === selectedId)) {
        const nextQuestion = firstRemainingQuestion(channelId, search, queryClient, excludedIds);
        const proceed = (): void => {
          setDeleteFailure(null);
          setShowSettings(false);
          if (nextQuestion === null) {
            setSelectedId(NEW_QUESTION);
            setNewQuestionSession((session) => session + 1);
            setSelectedQuestion(null);
            setDetailOpen(true);
          } else {
            setSelectedId(nextQuestion.id);
            setSelectedQuestion(nextQuestion);
          }
        };
        setDeleteFailure("deleted");
        if (switchRef.current === null) proceed();
        else switchRef.current(proceed);
      }

      if (excludedIds.size > 0) reconcileDeletedQuestions(channelId, refreshed.questions);
    });
  }, [channelId, deletedQuestionIds, queryClient, search, selectedId]);

  if (selectedId === null && data !== undefined) {
    const first = questions[0] ?? null;
    setSelectedId(first?.id ?? NEW_QUESTION);
    setSelectedQuestion(first);
  }

  const requestSwitch = useCallback((proceed: () => void): void => {
    if (switchRef.current === null) proceed();
    else switchRef.current(proceed);
  }, []);

  const cancelPendingDeleteSelection = (): void => { pendingDeleteSelection.current = null; };

  useEffect(() => {
    const deletingId = pendingDeleteSelection.current;
    if (deletingId === null || selectedIdRef.current !== NEW_QUESTION) return;
    const next = questions.find((question) => question.id !== deletingId);
    if (next === undefined) return;
    pendingDeleteSelection.current = null;
    requestSwitch(() => {
      setShowSettings(false);
      setSelectedId(next.id);
      setSelectedQuestion(next);
    });
  }, [questions, requestSwitch, selectedId]);

  const chooseQuestion = (question: BlitzQuestion): void => {
    cancelPendingDeleteSelection();
    if (selectedId === question.id && !showSettings) {
      setDetailOpen(true);
      return;
    }
    requestSwitch(() => {
      setShowSettings(false);
      setDeleteFailure(null);
      setSelectedId(question.id);
      setSelectedQuestion(question);
      setDetailOpen(true);
    });
  };

  const newQuestion = (): void => {
    cancelPendingDeleteSelection();
    requestSwitch(() => {
      setSearch("");
      setPage(1);
      setShowSettings(false);
      setDeleteFailure(null);
      setSelectedId(NEW_QUESTION);
      setNewQuestionSession((session) => session + 1);
      setSelectedQuestion(null);
      setDetailOpen(true);
    });
  };

  const openSettings = (): void => { cancelPendingDeleteSelection(); setShowSettings(true); setDetailOpen(true); };
  const closeSettings = (): void => {
    cancelPendingDeleteSelection();
    requestSwitch(() => { setShowSettings(false); setDetailOpen(true); });
  };

  const saveQuestion = useCallback(async (draft: Draft, revision?: number, saveAsNew = false): Promise<BlitzQuestion | null> => {
    const input = questionInput(draft);
    if (input === null) return null;
    const saved = selectedId === NEW_QUESTION || saveAsNew
      ? await createBlitzQuestion(channelId, input)
      : await updateBlitzQuestion(channelId, selectedId ?? "", revision ?? 1, input);
    await questionsQuery.refetch();
    return saved;
  }, [channelId, questionsQuery, selectedId]);

  const reloadQuestion = async (questionId: string): Promise<BlitzQuestion> => {
    const latest = await loadBlitzQuestion(channelId, questionId);
    setDeleteFailure(null);
    queryClient.setQueryData(moduleQueryKey(channelId, "blitz_round", "questions:1:"), (current: BlitzQuestionPage | undefined) => {
      if (current === undefined) return current;
      return { ...current, questions: current.questions.map((question) => question.id === questionId ? latest : question) };
    });
    setSelectedQuestion(latest);
    return latest;
  };

  const reloadSettings = async (): Promise<{ settings: BlitzRoundSettings; revision: number }> => {
    const latest = await loadBlitzSettings(channelId);
    queryClient.setQueryData(moduleQueryKey(channelId, "blitz_round", "settings"), latest);
    return latest;
  };

  const discardDeletedQuestion = (): void => {
    cancelPendingDeleteSelection();
    setDeleteFailure(null);
    setSelectedId(NEW_QUESTION);
    setNewQuestionSession((session) => session + 1);
    setSelectedQuestion(null);
    setShowSettings(false);
    setDetailOpen(true);
  };

  const selectSavedQuestion = (saved: BlitzQuestion): void => {
    cancelPendingDeleteSelection();
    setDeleteFailure(null);
    setSelectedId(saved.id);
    setSelectedQuestion(saved);
  };

  const requestDelete = (questionId: string): void => {
    setDeleteIntent({ questionId, opened: false });
    setDeleteError(undefined);
    setDeleteFailure(null);
  };
  const openDeleteConfirmation = (questionId: string): void => {
    setDeleteIntent((intent) => intent?.questionId === questionId ? { ...intent, opened: true } : intent);
  };
  const cancelDelete = (questionId: string): void => {
    setDeleteIntent((intent) => intent?.questionId === questionId ? null : intent);
  };

  const deleteQuestion = deleteIntent === null
    ? null
    : selectedQuestion?.id === deleteIntent.questionId
      ? selectedQuestion
      : questions.find((question) => question.id === deleteIntent.questionId) ?? null;

  const confirmDelete = async (): Promise<void> => {
    if (deleteIntent === null || deleteQuestion === null) return;
    const deletingId = deleteIntent.questionId;
    setDeletePending(true);
    setDeleteError(undefined);
    try {
      try {
        await deleteBlitzQuestion(channelId, deletingId, deleteQuestion.revision);
      } catch (failure: unknown) {
        const code = blitzErrorCode(failure);
        if (code === "question_conflict" || code === "question_deleted") {
          setDeleteIntent(null);
          setDeleteFailure(code === "question_conflict" ? "conflict" : "deleted");
        } else setDeleteError(labels.deleteError);
        return;
      }

      setDeleteIntent(null);
      recordDeletedQuestion(channelId, deletingId);
      if (selectedIdRef.current === deletingId) {
        const currentSelection = questions.find((question) => question.id !== deletingId && !deletedQuestionIds.has(question.id));
        if (currentSelection === undefined) {
          pendingDeleteSelection.current = deletingId;
          setSelectedId(NEW_QUESTION);
          setNewQuestionSession((session) => session + 1);
          setSelectedQuestion(null);
        } else {
          pendingDeleteSelection.current = null;
          setSelectedId(currentSelection.id);
          setSelectedQuestion(currentSelection);
        }
        setShowSettings(false);
      }
      await queryClient.invalidateQueries({ predicate: (query) => isQuestionListQuery(channelId, query) });
    } finally {
      setDeletePending(false);
    }
  };

  const retryQuestionList = (): void => {
    void pageQuery.refetch();
  };

  const toolbar = <div className="blitz-panel__toolbar">
    <div className="blitz-panel__toolbar-top">
      <Field variant="search" label={labels.search} clearLabel={labels.clearSearch} value={search} onChange={(value) => { cancelPendingDeleteSelection(); setSearch(value); setPage(1); }} placeholder={labels.searchPlaceholder} />
      <Button variant="primary" icon="add" disabled={!canManage} onClick={newQuestion}>{labels.addQuestion}</Button>
    </div>
    <div className="blitz-panel__pagination" aria-label={labels.questions}>
      <Button size="compact" icon="collapse" iconOnly ariaLabel={labels.previousPage} disabled={effectivePage <= 1} onClick={() => { cancelPendingDeleteSelection(); setPage(Math.max(1, effectivePage - 1)); }} />
      <span>{labels.pageCount(effectivePage, maxPage ?? effectivePage)}</span>
      <Button size="compact" disabled={maxPage === undefined || effectivePage >= maxPage} onClick={() => { cancelPendingDeleteSelection(); setPage(Math.min(maxPage ?? effectivePage, effectivePage + 1)); }}>{labels.nextPage}</Button>
      <span className="blitz-panel__count">{labels.questionCount(knownTotal ?? 0)}</span>
    </div>
  </div>;

  const list = questionsQuery.isPending && data === undefined
    ? <div className="blitz-panel__list-placeholder" aria-hidden="true"><span /><span /><span /><span /></div>
    : pageQuery.isError || questionsQuery.isError
      ? <div className="blitz-panel__empty"><p>{labels.loadError}</p><Button onClick={retryQuestionList}>{labels.retry}</Button></div>
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
      : <SettingsEditor channelId={channelId} language={language === "en" ? "en" : "de"} settings={settingsQuery.data.settings} revision={settingsQuery.data.revision} canManage={canManage} onBack={closeSettings} onReload={reloadSettings} registerSwitch={(switcher) => { switchRef.current = switcher; }} onSaved={(settings, revision) => {
        queryClient.setQueryData(moduleQueryKey(channelId, "blitz_round", "settings"), { settings, revision });
      }} />
    : selectedId === null
      ? <div className="blitz-panel__placeholder"><PageHeader title={labels.title} subtitle={labels.noSelection} /></div>
      : <QuestionEditor
        key={`${selectedId}:${String(currentQuestion?.revision ?? 0)}:${selectedId === NEW_QUESTION ? String(newQuestionSession) : ""}`}
        question={currentQuestion}
        isNew={selectedId === NEW_QUESTION}
        language={language === "en" ? "en" : "de"}
        canManage={canManage}
        onSave={saveQuestion}
        onSaved={selectSavedQuestion}
        deleteFailure={deleteFailure}
        onRequestDelete={requestDelete}
        onOpenDelete={openDeleteConfirmation}
        onCancelDelete={cancelDelete}
        onReload={reloadQuestion}
        onDiscardDeleted={discardDeletedQuestion}
        onOpenSettings={openSettings}
        registerSwitch={(switcher) => { switchRef.current = switcher; }}
        onEdit={cancelPendingDeleteSelection}
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
      onCloseDetail={() => { cancelPendingDeleteSelection(); requestSwitch(() => { setDetailOpen(false); }); }}
    />
    <ConfirmDialog
      opened={deleteIntent?.opened === true && deleteQuestion !== null}
      title={labels.deleteTitle}
      description={labels.deleteConfirm}
      confirmLabel={labels.delete}
      cancelLabel={labels.cancel}
      danger
      pending={deletePending}
      {...(deleteError === undefined ? {} : { error: deleteError })}
      onCancel={() => { if (deleteIntent !== null) cancelDelete(deleteIntent.questionId); }}
      onConfirm={() => { void confirmDelete(); }}
    />
  </div>;
}

function QuestionEditor({ question, isNew, language, canManage, onSave, onSaved, deleteFailure, onRequestDelete, onOpenDelete, onCancelDelete, onReload, onDiscardDeleted, onOpenSettings, registerSwitch, onEdit }: {
  question: BlitzQuestion | null;
  isNew: boolean;
  language: "de" | "en";
  canManage: boolean;
  onSave: (draft: Draft, revision?: number, saveAsNew?: boolean) => Promise<BlitzQuestion | null>;
  onSaved: (question: BlitzQuestion) => void;
  deleteFailure: "conflict" | "deleted" | null;
  onRequestDelete: (questionId: string) => void;
  onOpenDelete: (questionId: string) => void;
  onCancelDelete: (questionId: string) => void;
  onReload: (questionId: string) => Promise<BlitzQuestion>;
  onDiscardDeleted: () => void;
  onOpenSettings: () => void;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
  onEdit: () => void;
}): ReactElement {
  const labels = blitzTexts(language);
  const draft = useDraft(fromQuestion(question));
  const [pendingAnswer, setPendingAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [serverConflict, setServerConflict] = useState(false);
  const [serverDeleted, setServerDeleted] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const validation = validateBlitzQuestion({
    ...draft.value,
    answers: draft.value.kind === "scramble" ? [draft.value.prompt] : draft.value.answers,
  });
  const input = questionInput(draft.value);
  const invalid = input === null || (draft.value.kind === "quiz" && pendingAnswer.trim().length > 0);
  const reset = (): void => { draft.reset(); setPendingAnswer(""); setSaveError(undefined); setAttempted(false); };
  const saveRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const guard = useDraftGuard(draft.dirty || pendingAnswer.trim().length > 0, () => saveRef.current(), reset);
  const { guardSwitch } = guard;

  const save = async (saveAsNew = false): Promise<string | null> => {
    if (saveInFlight.current !== null) return saveInFlight.current;
    const operation = (async (): Promise<string | null> => {
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
        const saved = await onSave(draft.value, question?.revision, saveAsNew);
        if (saved === null) {
          setSaveError(labels.saveError);
          return labels.saveError;
        }
        draft.accept(fromQuestion(saved));
        setPendingAnswer("");
        setAttempted(false);
        setServerConflict(false);
        setServerDeleted(false);
        onSaved(saved);
        guard.completeSwitch();
        return null;
      } catch (failure: unknown) {
        const code = blitzErrorCode(failure);
        const message = code === "question_limit_reached" ? labels.questionLimit
          : code === "question_conflict" ? labels.conflict
            : code === "question_deleted" ? labels.questionDeletedConflict : labels.saveError;
        setSaveError(message);
        if (code === "question_conflict") setServerConflict(true);
        if (code === "question_deleted") setServerDeleted(true);
        return message;
      } finally {
        setSaving(false);
      }
    })();
    saveInFlight.current = operation;
    try {
      return await operation;
    } finally {
      if (saveInFlight.current === operation) saveInFlight.current = null;
    }
  };

  const reloadCurrent = (): void => {
    if (question === null) return;
    setSaving(true);
    setSaveError(undefined);
    void onReload(question.id).then((latest) => {
      draft.accept(fromQuestion(latest));
      setPendingAnswer("");
      setServerConflict(false);
      setAttempted(false);
    }).catch((failure: unknown) => {
      if (blitzErrorCode(failure) === "question_not_found") {
        setServerDeleted(true);
        setSaveError(labels.questionDeletedConflict);
      } else setSaveError(labels.loadError);
    }).finally(() => {
      setSaving(false);
    });
  };

  const saveDeletedAsNew = (): void => { void save(true); };

  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    registerSwitch(guardSwitch);
    return () => { registerSwitch(null); };
  }, [guardSwitch, registerSwitch]);
  useEffect(() => registerDashboardNavigationGuard(guardSwitch), [guardSwitch]);
  const typeOptions = [
    { value: "scramble" as const, label: labels.scramble },
    { value: "quiz" as const, label: labels.quiz },
  ];
  const localError = attempted && !validation.ok ? labels.validationError(validation.code) : undefined;
  const hasServerConflict = serverConflict || deleteFailure === "conflict";
  const hasServerDeleted = serverDeleted || deleteFailure === "deleted";
  const visibleSaveError = deleteFailure === "conflict" ? labels.conflict
    : deleteFailure === "deleted" ? labels.questionDeletedConflict : saveError;
  const saveProps = {
    dirty: draft.dirty || pendingAnswer.trim().length > 0,
    persistent: true,
    pending: saving,
    discardOnConflict: hasServerDeleted,
    ...(hasServerDeleted && !isNew ? { conflict: { message: labels.questionDeletedConflict, reloadLabel: labels.saveAsNew, onReload: saveDeletedAsNew } }
      : hasServerConflict && !isNew ? { conflict: { message: labels.conflict, reloadLabel: labels.reload, onReload: reloadCurrent } } : {}),
    ...(visibleSaveError === undefined ? {} : { error: visibleSaveError }),
    invalid,
    invalidMessage: labels.invalidAnswer,
    onSave: () => { void save(); },
    onInvalidSave: () => { setAttempted(true); },
    onDiscard: hasServerDeleted ? onDiscardDeleted : reset,
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
      {...(isNew ? {} : { overflow: <Button variant="subtle" danger="subtle" size="compact" onClick={() => {
        if (question === null) return;
        onRequestDelete(question.id);
        guard.guardSwitch(() => { onOpenDelete(question.id); }, () => { onCancelDelete(question.id); });
      }}><Icon name="remove" size={16} />{labels.delete}</Button> })}
      save={saveProps}
    />
    <div className="blitz-panel__editor">
      <SegmentChoice
        label={labels.type}
        value={draft.value.kind}
        options={typeOptions}
        disabled={!canManage || saving}
        onChange={(kind) => { onEdit(); draft.setValue((current) => ({ ...current, kind, answers: kind === "scramble" ? [] : current.answers })); setPendingAnswer(""); setAttempted(false); }}
        reserveError
      />
      <Field
        label={draft.value.kind === "scramble" ? labels.word : labels.prompt}
        value={draft.value.prompt}
        onChange={(prompt) => { onEdit(); draft.setValue((current) => ({ ...current, prompt })); setAttempted(false); }}
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
        onPendingChange={(answer) => { onEdit(); setPendingAnswer(answer); }}
        onChange={(answers) => { if (draft.value.kind === "quiz") { onEdit(); draft.setValue((current) => ({ ...current, answers })); } }}
        placeholder={labels.answerPlaceholder}
        disabled={!canManage || saving}
        max={10}
        separator="comma"
        removeLabel={labels.removeAnswer}
        validate={(answer) => answer.length > 60 || normalizeBlitzAnswer(answer).length === 0 ? labels.validationError("answer_invalid") : null}
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
        onChange={(enabled) => { onEdit(); draft.setValue((current) => ({ ...current, enabled })); }}
        hint={labels.enabledHint}
        disabled={!canManage || saving}
      />
      <div className="blitz-panel__error-slot" role="status" aria-live="polite">{visibleSaveError ?? "\u00a0"}</div>
    </div>
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.unsavedTitle}
      description={labels.unsavedDescription}
      confirmLabel={labels.discard}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.save, onClick: () => { void guard.saveAndSwitch(); } }}
      pending={guard.saving || saving}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
      onCancel={guard.continueEditing}
      onConfirm={guard.discardAndSwitch}
    />
  </div>;
}

function SettingsEditor({ channelId, language, settings, revision, canManage, onBack, onReload, registerSwitch, onSaved }: {
  channelId: string;
  language: "de" | "en";
  settings: BlitzRoundSettings;
  revision: number;
  canManage: boolean;
  onBack: () => void;
  onReload: () => Promise<{ settings: BlitzRoundSettings; revision: number }>;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
  onSaved: (settings: BlitzRoundSettings, revision: number) => void;
}): ReactElement {
  const labels = blitzTexts(language);
  const queryClient = useDashboardQueryClient();
  const draft = useDraft(settings);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [saving, setSaving] = useState(false);
  const savePromise = useRef<Promise<string | null> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [serverConflict, setServerConflict] = useState(false);
  const parsed = blitzRoundSettingsSchema.safeParse(draft.value);
  const valid = parsed.success;

  const reset = (): void => { draft.reset(); setError(undefined); setSaved(false); };

  const save = (): Promise<string | null> => {
    if (savePromise.current !== null) return savePromise.current;
    if (!canManage || !valid) return Promise.resolve(labels.settingsError);
    setSaving(true);
    setError(undefined);
    setSaved(false);
    const request = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite(queryClient, channelId, "blitz_round", "settings", () => saveBlitzSettings(channelId, currentRevision, draft.value), {
          baselineRevision: currentRevision,
          updateCache: (_current, next) => next,
        });
        draft.accept(result.settings);
        setCurrentRevision(result.revision);
        onSaved(result.settings, result.revision);
        setServerConflict(false);
        setSaved(true);
        return null;
      } catch (failure: unknown) {
        const conflicted = blitzErrorCode(failure) === "module_settings_changed_concurrently";
        const message = conflicted ? labels.settingsConflict : labels.settingsError;
        if (conflicted) setServerConflict(true);
        setError(message);
        return message;
      } finally {
        setSaving(false);
        savePromise.current = null;
      }
    })();
    savePromise.current = request;
    return request;
  };

  const reloadCurrent = (): void => {
    setSaving(true);
    setError(undefined);
    void onReload().then((latest) => {
      draft.accept(latest.settings);
      setCurrentRevision(latest.revision);
      onSaved(latest.settings, latest.revision);
      setServerConflict(false);
      setSaved(false);
    }).catch(() => {
      setError(labels.loadError);
    }).finally(() => {
      setSaving(false);
    });
  };

  const saveProps = {
    dirty: draft.dirty,
    persistent: true,
    pending: saving,
    saved,
    ...(serverConflict ? { conflict: { message: labels.settingsConflict, reloadLabel: labels.reloadSettings, onReload: reloadCurrent } } : {}),
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
  useEffect(() => registerDashboardNavigationGuard(guardSwitch), [guardSwitch]);
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
      pending={guard.saving || saving}
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
