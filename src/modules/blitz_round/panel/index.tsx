import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";

import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardCommonTexts } from "../../../dashboard/locale";
import {
  Badge, Button, ChipsInput, CollectionPage, ConfirmDialog, Field, FieldPair, Icon, PageHeader,
  registerDashboardNavigationGuard, SegmentChoice, SwitchRow, SwitchSection, TemplateTextField, UnitInput, useDraft, useDraftGuard,
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

const questionQueryPart = (questionId: string): string => `question:${questionId}`;

const invalidateQuestionDetail = (queryClient: DashboardQueryClient, channelId: string, questionId: string): Promise<void> =>
  queryClient.invalidateQueries({
    queryKey: moduleQueryKey(channelId, "blitz_round", questionQueryPart(questionId)),
    exact: true,
  });

const invalidateQuestionLists = (queryClient: DashboardQueryClient, channelId: string): Promise<void> =>
  queryClient.invalidateQueries({ predicate: (query) => isQuestionListQuery(channelId, query) });

const invalidateQuestionQueries = (queryClient: DashboardQueryClient, channelId: string, questionId: string): Promise<void> =>
  Promise.all([
    invalidateQuestionDetail(queryClient, channelId, questionId),
    invalidateQuestionLists(queryClient, channelId),
  ]).then(() => undefined);

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

const reconcileDeletedQuestions = (channelId: string, queryClient: DashboardQueryClient): void => {
  const cachedQuestionIds = new Set<string>();
  queryClient.getQueryCache().findAll({ predicate: (query) => isQuestionListQuery(channelId, query) }).forEach((query) => {
    const data = query.state.data as BlitzQuestionPage | undefined;
    if (!Array.isArray(data?.questions)) return;
    data.questions.forEach((question) => cachedQuestionIds.add(question.id));
  });
  const remaining = new Set([...getDeletedQuestionIds(channelId)].filter((questionId) => cachedQuestionIds.has(questionId)));
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
  const commonLabels = dashboardCommonTexts(language);
  const queryClient = useDashboardQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  const [questionEditorSession, setQuestionEditorSession] = useState(0);
  const questionEditorSessionRef = useRef(0);
  const [questionDetailTarget, setQuestionDetailTarget] = useState<{ id: string; session: number } | null>(null);
  const [questionDetailFetchAttempt, setQuestionDetailFetchAttempt] = useState(0);
  const [sessionQuestion, setSessionQuestion] = useState<{ id: string; session: number; question: BlitzQuestion } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [deleteIntent, setDeleteIntent] = useState<{ questionId: string; revision: number; opened: boolean } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const deletePendingSession = useRef<symbol | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [deleteFailure, setDeleteFailure] = useState<"conflict" | "deleted" | null>(null);
  const pendingDestination = useRef<{ session: symbol; run: () => void } | null>(null);
  const questionSavePendingSession = useRef<symbol | null>(null);
  const activeEditorSession = useRef<symbol | null>(null);
  const subscribeToDeletedIds = useCallback((subscriber: () => void) => subscribeToDeletedQuestionIds(channelId, subscriber), [channelId]);
  const readDeletedIds = useCallback(() => getDeletedQuestionIds(channelId), [channelId]);
  const deletedQuestionIds = useSyncExternalStore(subscribeToDeletedIds, readDeletedIds, () => EMPTY_DELETED_QUESTION_IDS);
  const pendingDeleteSelection = useRef<{ questionId: string; session: symbol | null } | null>(null);
  const switchRef = useRef<((proceed: () => void) => void) | null>(null);
  const queuePendingDestination = useCallback((session: symbol, destination: () => void): boolean => {
    const savePending = questionSavePendingSession.current === session;
    if (savePending || pendingDestination.current?.session === session) pendingDestination.current = { session, run: destination };
    return savePending;
  }, []);
  const clearPendingDestination = useCallback((session: symbol, destination: () => void): void => {
    if (pendingDestination.current?.session === session && pendingDestination.current.run === destination) pendingDestination.current = null;
  }, []);
  const setQuestionSavePending = useCallback((session: symbol, pending: boolean): void => {
    if (pending) questionSavePendingSession.current = session;
    else if (questionSavePendingSession.current === session) questionSavePendingSession.current = null;
  }, []);
  const registerEditorSession = useCallback((session: symbol): (() => void) => {
    activeEditorSession.current = session;
    if (pendingDeleteSelection.current?.session === null) {
      pendingDeleteSelection.current = { ...pendingDeleteSelection.current, session };
      void queryClient.invalidateQueries({ predicate: (query) => isQuestionListQuery(channelId, query) });
    }
    if (deletePendingSession.current !== null && deletePendingSession.current !== session) {
      deletePendingSession.current = null;
      setDeletePending(false);
    }
    if (questionSavePendingSession.current !== session) questionSavePendingSession.current = null;
    if (pendingDestination.current?.session !== session) pendingDestination.current = null;
    return () => {
      if (activeEditorSession.current === session) activeEditorSession.current = null;
      if (deletePendingSession.current === session) {
        deletePendingSession.current = null;
        setDeletePending(false);
      }
      if (questionSavePendingSession.current === session) questionSavePendingSession.current = null;
      if (pendingDestination.current?.session === session) pendingDestination.current = null;
    };
  }, [channelId, queryClient]);
  const isCurrentEditorSession = useCallback((session: symbol): boolean => activeEditorSession.current === session, []);
  const pageQuery = useModuleQuery(channelId, "blitz_round", `questions:${String(page)}:${search}`, (signal) => loadBlitzQuestions(channelId, page, search, signal));
  const knownTotal = pageQuery.data?.total ?? lastKnownQuestionTotal(channelId, search, queryClient);
  const maxPage = knownTotal === undefined ? undefined : Math.max(1, Math.ceil(knownTotal / BLITZ_QUESTION_PAGE_SIZE));
  const effectivePage = maxPage === undefined ? page : Math.min(page, maxPage);
  const questionsQuery = useModuleQuery(channelId, "blitz_round", `questions:${String(effectivePage)}:${search}`, (signal) => loadBlitzQuestions(channelId, effectivePage, search, signal));
  const selectedQuestionId = selectedId !== null && selectedId !== NEW_QUESTION ? selectedId : null;
  const selectedQuestionQuery = useModuleQuery(
    channelId,
    "blitz_round",
    selectedQuestionId === null ? "question:none" : questionQueryPart(selectedQuestionId),
    (signal) => loadBlitzQuestion(channelId, selectedQuestionId ?? "", signal),
    { enabled: false },
  );
  const settingsQuery = useModuleQuery(channelId, "blitz_round", "settings", (signal) => loadBlitzSettings(channelId, signal));
  const data = questionsQuery.data;
  const questions = (data?.questions ?? []).filter((question) => !deletedQuestionIds.has(question.id));

  const beginQuestionEditorSession = useCallback((questionId: string): void => {
    const session = questionEditorSessionRef.current + 1;
    questionEditorSessionRef.current = session;
    setQuestionEditorSession(session);
    setSessionQuestion(null);
    setQuestionDetailTarget(questionId === NEW_QUESTION ? null : { id: questionId, session });
    setQuestionDetailFetchAttempt(0);
    selectedIdRef.current = questionId;
    setSelectedId(questionId);
  }, [setQuestionDetailFetchAttempt]);

  useEffect(() => {
    const target = questionDetailTarget;
    if (target === null) return;
    const queryKey = moduleQueryKey(channelId, "blitz_round", questionQueryPart(target.id));
    let current = true;
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      if (!current) return undefined;
      return queryClient.query({
        queryKey,
        queryFn: ({ signal }) => loadBlitzQuestion(channelId, target.id, signal),
        staleTime: 0,
      });
    }).then((question) => {
      if (question !== undefined && current && questionEditorSessionRef.current === target.session && selectedIdRef.current === target.id) {
        setSessionQuestion({ id: target.id, session: target.session, question });
      }
    }).catch(() => undefined);
    return () => {
      current = false;
      void queryClient.cancelQueries({ queryKey, exact: true });
    };
  }, [channelId, questionDetailFetchAttempt, questionDetailTarget, queryClient]);

  const currentQuestion = sessionQuestion?.session === questionEditorSession && sessionQuestion.id === selectedId
    ? sessionQuestion.question : null;
  const questionDetailReady = selectedQuestionId !== null && currentQuestion !== null;

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
      if (!isQuestionListQuery(channelId, event.query)) return;
      const refreshed = event.query.state.data as BlitzQuestionPage | undefined;
      if (!Array.isArray(refreshed?.questions)) return;

      const excludedIds = getDeletedQuestionIds(channelId);
      if (excludedIds.size > 0) reconcileDeletedQuestions(channelId, queryClient);
    });
  }, [channelId, deletedQuestionIds, queryClient]);

  useEffect(() => {
    if (selectedId !== null || data === undefined) return;
    const first = questions[0] ?? null;
    beginQuestionEditorSession(first?.id ?? NEW_QUESTION);
  }, [beginQuestionEditorSession, data, questions, selectedId]);

  const requestSwitch = useCallback((proceed: () => void): void => {
    if (switchRef.current === null) proceed();
    else switchRef.current(proceed);
  }, []);

  const cancelPendingDeleteSelection = (): void => { pendingDeleteSelection.current = null; };

  useEffect(() => {
    const pending = pendingDeleteSelection.current;
    if (pending === null || pending.session === null || selectedIdRef.current !== NEW_QUESTION) return;
    if (!isCurrentEditorSession(pending.session)) {
      pendingDeleteSelection.current = null;
      return;
    }
    const next = questions.find((question) => question.id !== pending.questionId);
    if (next === undefined) return;
    pendingDeleteSelection.current = null;
    requestSwitch(() => {
      setShowSettings(false);
      beginQuestionEditorSession(next.id);
    });
  }, [beginQuestionEditorSession, channelId, isCurrentEditorSession, questions, queryClient, requestSwitch, selectedId]);

  const chooseQuestion = (questionId: string): void => {
    cancelPendingDeleteSelection();
    if (selectedId === questionId && !showSettings) {
      setDetailOpen(true);
      return;
    }
    requestSwitch(() => {
      setShowSettings(false);
      setDeleteFailure(null);
      beginQuestionEditorSession(questionId);
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
      beginQuestionEditorSession(NEW_QUESTION);
      setDetailOpen(true);
    });
  };

  const openSettings = (): void => {
    cancelPendingDeleteSelection();
    if (settingsQuery.isError) void settingsQuery.refetch();
    setShowSettings(true);
    setDetailOpen(true);
  };
  const closeSettings = (): void => {
    cancelPendingDeleteSelection();
    requestSwitch(() => {
      setShowSettings(false);
      if (selectedId !== null) beginQuestionEditorSession(selectedId);
      setDetailOpen(true);
    });
  };

  const saveQuestion = useCallback(async (draft: Draft, revision: number | undefined, saveAsNew: boolean, session: symbol): Promise<BlitzQuestion | null> => {
    const input = questionInput(draft);
    if (input === null) return null;
    const saved = selectedId === NEW_QUESTION || saveAsNew
      ? await createBlitzQuestion(channelId, input)
      : await updateBlitzQuestion(channelId, selectedId ?? "", revision ?? 1, input);
    await invalidateQuestionQueries(queryClient, channelId, saved.id);
    return isCurrentEditorSession(session) ? saved : null;
  }, [channelId, isCurrentEditorSession, queryClient, selectedId]);

  const reloadQuestion = async (questionId: string, session: symbol): Promise<BlitzQuestion> => {
    const latest = await loadBlitzQuestion(channelId, questionId);
    await invalidateQuestionQueries(queryClient, channelId, questionId);
    if (isCurrentEditorSession(session)) {
      setSessionQuestion({ id: questionId, session: questionEditorSessionRef.current, question: latest });
      setDeleteFailure(null);
    }
    return latest;
  };

  const reloadSettings = async (session: symbol): Promise<{ settings: BlitzRoundSettings; revision: number } | null> => {
    const latest = await refetchModuleQueryData<{ settings: BlitzRoundSettings; revision: number }>(queryClient, channelId, "blitz_round", "settings");
    return isCurrentEditorSession(session) ? latest : null;
  };

  const discardDeletedQuestion = (): void => {
    cancelPendingDeleteSelection();
    setDeleteFailure(null);
    beginQuestionEditorSession(NEW_QUESTION);
    setShowSettings(false);
    setDetailOpen(true);
  };

  const selectSavedQuestion = (saved: BlitzQuestion): void => {
    cancelPendingDeleteSelection();
    setDeleteFailure(null);
    setDeleteIntent((intent) => intent?.questionId === saved.id ? { ...intent, revision: saved.revision } : intent);
    setSessionQuestion({ id: saved.id, session: questionEditorSessionRef.current, question: saved });
    selectedIdRef.current = saved.id;
    setSelectedId(saved.id);
  };

  const requestDelete = (questionId: string, revision: number): void => {
    setDeleteIntent({ questionId, revision, opened: false });
    setDeleteError(undefined);
    setDeleteFailure(null);
  };
  const openDeleteConfirmation = (questionId: string): void => {
    setDeleteIntent((intent) => intent?.questionId === questionId ? { ...intent, opened: true } : intent);
  };
  const cancelDelete = (questionId: string): void => {
    setDeleteIntent((intent) => intent?.questionId === questionId ? null : intent);
  };

  const deleteQuestion = deleteIntent === null || currentQuestion?.id !== deleteIntent.questionId ? null : currentQuestion;

  const confirmDelete = async (): Promise<void> => {
    if (deleteIntent === null || deleteQuestion === null) return;
    const session = activeEditorSession.current;
    const isCurrentSession = (): boolean => session !== null && isCurrentEditorSession(session);
    const deletingId = deleteIntent.questionId;
    let deferListRefresh = false;
    deletePendingSession.current = session;
    setDeletePending(true);
    setDeleteError(undefined);
    try {
      try {
        await deleteBlitzQuestion(channelId, deletingId, deleteIntent.revision);
      } catch (failure: unknown) {
        const code = blitzErrorCode(failure);
        if (code === "question_conflict" || code === "question_deleted") {
          setDeleteIntent((intent) => intent?.questionId === deletingId ? null : intent);
          if (isCurrentSession()) setDeleteFailure(code === "question_conflict" ? "conflict" : "deleted");
        } else if (isCurrentSession()) setDeleteError(labels.deleteError);
        return;
      }

      setDeleteIntent((intent) => intent?.questionId === deletingId ? null : intent);
      await invalidateQuestionDetail(queryClient, channelId, deletingId);
      recordDeletedQuestion(channelId, deletingId);
      if (isCurrentSession() && selectedIdRef.current === deletingId) {
        const currentSelection = firstRemainingQuestion(channelId, search, queryClient, getDeletedQuestionIds(channelId));
        if (currentSelection === null) {
          pendingDeleteSelection.current = { questionId: deletingId, session: null };
          deferListRefresh = true;
          beginQuestionEditorSession(NEW_QUESTION);
        } else {
          pendingDeleteSelection.current = null;
          beginQuestionEditorSession(currentSelection.id);
        }
        setShowSettings(false);
      }
      if (!deferListRefresh) {
        // The list refresh belongs to this delete session; its query results only update caches.
        await invalidateQuestionLists(queryClient, channelId);
      }
    } finally {
      if (deletePendingSession.current === session && isCurrentSession()) {
        deletePendingSession.current = null;
        setDeletePending(false);
      }
    }
  };

  const retryQuestionList = (): void => {
    const requestedPages = new Set([page, effectivePage]);
    void queryClient.refetchQueries({
      predicate: (query) => isQuestionListQuery(channelId, query) && questionListSearch(query) === search &&
        requestedPages.has(questionListPage(query)) && query.state.status === "error",
      type: "all",
    });
  };

  const toolbar = <div className="blitz-panel__toolbar">
    <div className="blitz-panel__toolbar-top">
      <Field variant="search" label={labels.search} clearLabel={labels.clearSearch} value={search} onChange={(value) => { cancelPendingDeleteSelection(); setSearch(value); setPage(1); }} placeholder={labels.searchPlaceholder} />
      <Button variant="primary" icon="add" disabled={!canManage} onClick={newQuestion}>{labels.addQuestion}</Button>
    </div>
    <div className="blitz-panel__pagination" aria-label={labels.questions}>
      <Button size="compact" icon="collapse" iconOnly ariaLabel={labels.previousPage} disabled={page <= 1} onClick={() => { cancelPendingDeleteSelection(); setPage(Math.max(1, page - 1)); }} />
      <span>{labels.pageCount(effectivePage, maxPage ?? effectivePage)}</span>
      <Button size="compact" disabled={maxPage === undefined || page >= maxPage} onClick={() => { cancelPendingDeleteSelection(); setPage(Math.min(maxPage ?? page, page + 1)); }}>{labels.nextPage}</Button>
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
            onClick={() => chooseQuestion(question.id)}
          >
            <span className={`blitz-panel__indicator${question.enabled ? " blitz-panel__indicator--on" : ""}`} aria-hidden="true" />
            <span className="blitz-panel__row-copy">
              <span className="blitz-panel__row-heading"><Badge tone="neutral">{question.kind === "scramble" ? labels.scramble : labels.quiz}</Badge><strong>{question.prompt}</strong></span>
              <small>{question.kind === "scramble" ? question.prompt : question.answers[0] ?? ""}</small>
            </span>
          </button>)}
        </div>;

  const questionReady = selectedQuestionId !== null && questionDetailReady;
  const detail = showSettings
    ? settingsQuery.data === undefined
      ? <div className="blitz-panel__settings-loading" aria-live="polite">{settingsQuery.isError
        ? <><p>{labels.loadError}</p><Button disabled={settingsQuery.isFetching} onClick={() => { void settingsQuery.refetch(); }}>{commonLabels.retry}</Button></>
        : labels.saving}</div>
      : <SettingsEditor channelId={channelId} language={language === "en" ? "en" : "de"} settings={settingsQuery.data.settings} revision={settingsQuery.data.revision} canManage={canManage} onBack={closeSettings} onReload={reloadSettings} registerSwitch={(switcher) => { switchRef.current = switcher; }} registerEditorSession={registerEditorSession} isCurrentEditorSession={isCurrentEditorSession} />
      : selectedId === null
      ? <div className="blitz-panel__placeholder"><PageHeader title={labels.title} subtitle={labels.noSelection} /></div>
      : selectedId !== NEW_QUESTION && !questionReady
        ? <div className="blitz-panel__settings-loading" aria-live="polite">{selectedQuestionQuery.isError
          ? <><p>{labels.loadError}</p><Button disabled={selectedQuestionQuery.isFetching} onClick={() => { setQuestionDetailFetchAttempt((attempt) => attempt + 1); }}>{commonLabels.retry}</Button></>
          : commonLabels.saving}</div>
      : <QuestionEditor
        key={questionEditorSession}
        question={currentQuestion}
        isNew={selectedId === NEW_QUESTION}
        language={language === "en" ? "en" : "de"}
        canManage={canManage}
        onSave={saveQuestion}
        onSaved={(saved, session) => {
          if (!isCurrentEditorSession(session)) return null;
          selectSavedQuestion(saved);
          const destination = pendingDestination.current;
          if (destination?.session !== session) return null;
          pendingDestination.current = null;
          return destination.run;
        }}
        deleteFailure={deleteFailure}
        onRequestDelete={requestDelete}
        onOpenDelete={openDeleteConfirmation}
        onCancelDelete={cancelDelete}
        onReload={reloadQuestion}
        onDiscardDeleted={discardDeletedQuestion}
        onOpenSettings={openSettings}
        onQueueNavigation={queuePendingDestination}
        onClearPendingNavigation={clearPendingDestination}
        onSavePendingChange={setQuestionSavePending}
        isCurrentEditorSession={isCurrentEditorSession}
        registerEditorSession={registerEditorSession}
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
      {...(showSettings && settingsQuery.data !== undefined ? {} : { backLabel: labels.back })}
      reserveDetailBack={showSettings}
      onCloseDetail={() => {
        if (showSettings) {
          closeSettings();
          return;
        }
        cancelPendingDeleteSelection();
        requestSwitch(() => { setDetailOpen(false); });
      }}
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

function QuestionEditor({ question, isNew, language, canManage, onSave, onSaved, deleteFailure, onRequestDelete, onOpenDelete, onCancelDelete, onReload, onDiscardDeleted, onOpenSettings, onQueueNavigation, onClearPendingNavigation, onSavePendingChange, isCurrentEditorSession, registerEditorSession, registerSwitch, onEdit }: {
  question: BlitzQuestion | null;
  isNew: boolean;
  language: "de" | "en";
  canManage: boolean;
  onSave: (draft: Draft, revision: number | undefined, saveAsNew: boolean, session: symbol) => Promise<BlitzQuestion | null>;
  onSaved: (question: BlitzQuestion, session: symbol) => (() => void) | null;
  deleteFailure: "conflict" | "deleted" | null;
  onRequestDelete: (questionId: string, revision: number) => void;
  onOpenDelete: (questionId: string) => void;
  onCancelDelete: (questionId: string) => void;
  onReload: (questionId: string, session: symbol) => Promise<BlitzQuestion>;
  onDiscardDeleted: () => void;
  onOpenSettings: () => void;
  onQueueNavigation: (session: symbol, destination: () => void) => boolean;
  onClearPendingNavigation: (session: symbol, destination: () => void) => void;
  onSavePendingChange: (session: symbol, pending: boolean) => void;
  isCurrentEditorSession: (session: symbol) => boolean;
  registerEditorSession: (session: symbol) => () => void;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
  onEdit: () => void;
}): ReactElement {
  const labels = blitzTexts(language);
  const [baseQuestion, setBaseQuestion] = useState(question);
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
  const editorSession = useRef(Symbol());
  const saveRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const parentCompletionInProgress = useRef(false);
  const guard = useDraftGuard(draft.dirty || pendingAnswer.trim().length > 0, () => saveRef.current(), reset);
  const { guardSwitch } = guard;

  const save = async (saveAsNew = false): Promise<string | null> => {
    if (saveInFlight.current !== null) return saveInFlight.current;
    const operation = (async (): Promise<string | null> => {
      const session = editorSession.current;
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
      onSavePendingChange(session, true);
      try {
        const saved = await onSave(draft.value, baseQuestion?.revision, saveAsNew, session);
        if (saved === null) {
          if (isCurrentEditorSession(session)) setSaveError(labels.saveError);
          return labels.saveError;
        }
        if (!isCurrentEditorSession(session)) return null;
        setBaseQuestion(saved);
        draft.accept(fromQuestion(saved));
        setPendingAnswer("");
        setAttempted(false);
        setServerConflict(false);
        setServerDeleted(false);
        const pendingDestination = onSaved(saved, session);
        if (pendingDestination === null) guard.completeSwitch();
        else {
          parentCompletionInProgress.current = true;
          try { guard.continueEditing(); }
          finally { parentCompletionInProgress.current = false; }
          pendingDestination();
        }
        return null;
      } catch (failure: unknown) {
        if (!isCurrentEditorSession(session)) return blitzErrorCode(failure) ?? labels.saveError;
        const code = blitzErrorCode(failure);
        const message = code === "question_limit_reached" ? labels.questionLimit
          : code === "question_conflict" ? labels.conflict
            : code === "question_deleted" ? labels.questionDeletedConflict : labels.saveError;
        setSaveError(message);
        if (code === "question_conflict") setServerConflict(true);
        if (code === "question_deleted") setServerDeleted(true);
        return message;
      } finally {
        onSavePendingChange(session, false);
        if (isCurrentEditorSession(session)) setSaving(false);
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
    if (baseQuestion === null) return;
    const session = editorSession.current;
    setSaving(true);
    setSaveError(undefined);
    void onReload(baseQuestion.id, session).then((latest) => {
      if (!isCurrentEditorSession(session)) return;
      setBaseQuestion(latest);
      draft.accept(fromQuestion(latest));
      setPendingAnswer("");
      setServerConflict(false);
      setAttempted(false);
    }).catch((failure: unknown) => {
      if (!isCurrentEditorSession(session)) return;
      if (blitzErrorCode(failure) === "question_not_found") {
        setServerDeleted(true);
        setSaveError(labels.questionDeletedConflict);
      } else setSaveError(labels.loadError);
    }).finally(() => {
      if (isCurrentEditorSession(session)) setSaving(false);
    });
  };

  const saveDeletedAsNew = (): void => { void save(true); };
  const guardSwitchWithPendingDestination = useCallback((proceed: () => void, cancel?: () => void): void => {
    const session = editorSession.current;
    const destination = (): void => {
      onClearPendingNavigation(session, destination);
      proceed();
    };
    const savePending = onQueueNavigation(session, destination);
    if (savePending && !draft.dirty && pendingAnswer.trim().length === 0) return;
    guardSwitch(destination, () => {
      onClearPendingNavigation(session, destination);
      if (!parentCompletionInProgress.current) cancel?.();
    });
  }, [draft.dirty, guardSwitch, onClearPendingNavigation, onQueueNavigation, pendingAnswer]);
  const requestSettings = (): void => { guardSwitchWithPendingDestination(onOpenSettings); };

  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    registerSwitch(guardSwitchWithPendingDestination);
    return () => { registerSwitch(null); };
  }, [guardSwitchWithPendingDestination, registerSwitch]);
  useEffect(() => registerEditorSession(editorSession.current), [registerEditorSession]);
  useEffect(() => registerDashboardNavigationGuard(guardSwitchWithPendingDestination), [guardSwitchWithPendingDestination]);
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
    mobileFixed: true,
    pending: saving,
    discardOnConflict: hasServerDeleted,
    ...(hasServerDeleted && !isNew ? { conflict: { message: labels.questionDeletedConflict, reloadLabel: labels.saveAsNew, onReload: saveDeletedAsNew } }
      : hasServerConflict && !isNew ? { conflict: { message: labels.conflict, reloadLabel: labels.reload, onReload: reloadCurrent } } : {}),
    ...(visibleSaveError === undefined ? {} : { error: visibleSaveError }),
    invalid,
    invalidMessage: labels.invalidAnswer,
    onSave: () => { void save(false); },
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
      className="page-header--editor"
      title={isNew ? labels.newQuestion : baseQuestion?.prompt ?? labels.title}
      badges={<Badge tone="neutral">{draft.value.kind === "scramble" ? labels.scramble : labels.quiz}</Badge>}
      pageActions={<Button variant="neutral" icon="tabSettings" onClick={requestSettings}>{labels.settings}</Button>}
      {...(isNew ? {} : { overflow: <Button variant="subtle" danger="subtle" size="compact" onClick={() => {
        if (baseQuestion === null) return;
        onRequestDelete(baseQuestion.id, baseQuestion.revision);
        guardSwitchWithPendingDestination(() => { onOpenDelete(baseQuestion.id); }, () => { onCancelDelete(baseQuestion.id); });
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

function SettingsEditor({ channelId, language, settings, revision, canManage, onBack, onReload, registerSwitch, registerEditorSession, isCurrentEditorSession }: {
  channelId: string;
  language: "de" | "en";
  settings: BlitzRoundSettings;
  revision: number;
  canManage: boolean;
  onBack: () => void;
  onReload: (session: symbol) => Promise<{ settings: BlitzRoundSettings; revision: number } | null>;
  registerSwitch: (switcher: ((proceed: () => void) => void) | null) => void;
  registerEditorSession: (session: symbol) => () => void;
  isCurrentEditorSession: (session: symbol) => boolean;
}): ReactElement {
  const labels = blitzTexts(language);
  const queryClient = useDashboardQueryClient();
  const draft = useDraft(settings);
  const savedInterval = useRef(settings.autoStartIntervalMinutes);
  const [autoStartInterval, setAutoStartInterval] = useState<number | "">(settings.autoStartIntervalMinutes);
  const editorSession = useRef(Symbol());
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [saving, setSaving] = useState(false);
  const savePromise = useRef<Promise<string | null> | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [serverConflict, setServerConflict] = useState(false);
  const parsed = blitzRoundSettingsSchema.safeParse(draft.value);
  const validInterval = typeof autoStartInterval === "number" && Number.isSafeInteger(autoStartInterval) &&
    autoStartInterval >= 15 && autoStartInterval <= 240 && autoStartInterval === draft.value.autoStartIntervalMinutes;
  const valid = parsed.success && validInterval;
  const dirty = draft.dirty || autoStartInterval !== draft.value.autoStartIntervalMinutes;

  const reset = (): void => {
    draft.reset();
    setAutoStartInterval(savedInterval.current);
    setError(undefined);
    setSaved(false);
  };

  const save = (): Promise<string | null> => {
    if (savePromise.current !== null) return savePromise.current;
    if (!canManage) return Promise.resolve(labels.settingsError);
    if (!valid) return Promise.resolve(labels.settingsInvalid);
    const session = editorSession.current;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    const request = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite(queryClient, channelId, "blitz_round", "settings", () => saveBlitzSettings(channelId, currentRevision, draft.value), {
          baselineRevision: currentRevision,
          updateCache: (_current, next) => next,
        });
        if (!isCurrentEditorSession(session)) return null;
        draft.accept(result.settings);
        savedInterval.current = result.settings.autoStartIntervalMinutes;
        setAutoStartInterval(result.settings.autoStartIntervalMinutes);
        setCurrentRevision(result.revision);
        setServerConflict(false);
        setSaved(true);
        return null;
      } catch (failure: unknown) {
        if (!isCurrentEditorSession(session)) return null;
        const conflicted = blitzErrorCode(failure) === "module_settings_changed_concurrently";
        const message = conflicted ? labels.settingsConflict : labels.settingsError;
        if (conflicted) setServerConflict(true);
        setError(message);
        return message;
      } finally {
        if (isCurrentEditorSession(session)) setSaving(false);
        savePromise.current = null;
      }
    })();
    savePromise.current = request;
    return request;
  };

  const reloadCurrent = (): void => {
    const session = editorSession.current;
    setSaving(true);
    setError(undefined);
    void onReload(session).then((latest) => {
      if (latest === null) return;
      if (!isCurrentEditorSession(session)) return;
      draft.accept(latest.settings);
      savedInterval.current = latest.settings.autoStartIntervalMinutes;
      setAutoStartInterval(latest.settings.autoStartIntervalMinutes);
      setCurrentRevision(latest.revision);
      setServerConflict(false);
      setSaved(false);
    }).catch(() => {
      if (isCurrentEditorSession(session)) setError(labels.loadError);
    }).finally(() => {
      if (isCurrentEditorSession(session)) setSaving(false);
    });
  };

  const saveProps = {
    dirty,
    persistent: true,
    mobileFixed: true,
    pending: saving,
    saved,
    ...(serverConflict ? { conflict: { message: labels.settingsConflict, reloadLabel: labels.reloadSettings, onReload: reloadCurrent } } : {}),
    ...(error === undefined ? {} : { error }),
    invalid: !valid,
    invalidMessage: labels.settingsInvalid,
    invalidStatus: labels.settingsInvalid,
    onSave: () => { void save(); },
    onDiscard: reset,
    saveLabel: labels.save,
    discardLabel: labels.discard,
    savedLabel: labels.saved,
    pendingLabel: labels.saving,
  };
  const guard = useDraftGuard(dirty, save, reset);
  const { guardSwitch } = guard;
  useEffect(() => registerEditorSession(editorSession.current), [registerEditorSession]);
  useEffect(() => registerDashboardNavigationGuard(guardSwitch), [guardSwitch]);
  useEffect(() => {
    registerSwitch(guardSwitch);
    return () => { registerSwitch(null); };
  }, [guardSwitch, registerSwitch]);
  const autoStartFields = [
    <SwitchRow
      key="auto-start-switch"
      label={labels.autoStart}
      checked={draft.value.autoStart}
      onChange={(autoStart) => { draft.setValue((current) => ({ ...current, autoStart })); }}
      hint={labels.autoStartHint}
      disabled={!canManage}
      pending={saving}
    />,
    <UnitInput
      key="auto-start-interval"
      label={labels.autoStartInterval}
      value={autoStartInterval}
      onChange={(value) => {
        setAutoStartInterval(value);
        if (typeof value === "number") draft.setValue((current) => ({ ...current, autoStartIntervalMinutes: value }));
      }}
      min={15}
      max={240}
      unit={labels.minutesUnit}
      hint={labels.autoStartIntervalHint}
      {...(validInterval ? {} : { error: labels.autoStartIntervalError })}
      disabled={!canManage || saving || !draft.value.autoStart}
      required
      clampOnBlur={false}
    />,
  ] as const;

  return <div className="blitz-panel__detail blitz-panel__settings">
    <PageHeader kind="blitz" className="page-header--editor" title={labels.settingsSection} pageActions={<Button variant="neutral" icon="collapse" onClick={() => { guard.guardSwitch(onBack); }}>{labels.back}</Button>} save={saveProps} />
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
          wrap
        />
      </div>
      <div className="blitz-panel__auto-start">
        <FieldPair>{autoStartFields}</FieldPair>
      </div>
      <TemplateSetting language={language} label={labels.startText} enabled={draft.value.startTextEnabled ?? draft.value.startText.trim().length > 0}
        enabledLabel={labels.messageEnabledLabel} onEnabledChange={(startTextEnabled) => { draft.setValue((current) => ({ ...current, startTextEnabled })); }}
        value={draft.value.startText} onChange={(startText) => { draft.setValue((current) => ({ ...current, startText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
      <TemplateSetting language={language} label={labels.solvedText} enabled={draft.value.solvedTextEnabled ?? draft.value.solvedText.trim().length > 0}
        enabledLabel={labels.messageEnabledLabel} onEnabledChange={(solvedTextEnabled) => { draft.setValue((current) => ({ ...current, solvedTextEnabled })); }}
        value={draft.value.solvedText} onChange={(solvedText) => { draft.setValue((current) => ({ ...current, solvedText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
      <TemplateSetting language={language} label={labels.timeoutText} enabled={draft.value.timeoutTextEnabled ?? draft.value.timeoutText.trim().length > 0}
        enabledLabel={labels.messageEnabledLabel} onEnabledChange={(timeoutTextEnabled) => { draft.setValue((current) => ({ ...current, timeoutTextEnabled })); }}
        value={draft.value.timeoutText} onChange={(timeoutText) => { draft.setValue((current) => ({ ...current, timeoutText })); }} disabled={!canManage || saving} hint={labels.roundTextHint} />
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

function TemplateSetting({ label, value, enabled, enabledLabel, onChange, onEnabledChange, disabled, hint, language }: {
  label: string;
  value: string;
  enabled: boolean;
  enabledLabel: string;
  onChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  disabled: boolean;
  hint: string;
  language: "de" | "en";
}): ReactElement {
  return <div className="ui-settings-editor__message">
    <div className="ui-settings-editor__message-heading">
      <strong>{label}</strong>
      <div className="ui-settings-editor__message-toggle">
        <SwitchRow label={enabledLabel} ariaLabel={`${label}: ${enabledLabel}`} checked={enabled} onChange={onEnabledChange} disabled={disabled} />
      </div>
    </div>
    <TemplateTextField label={label} value={value} onChange={onChange} disabled={disabled} hint={hint}
      maxLength={500} minRows={2} required={enabled} messages={blitzTemplateMessages[language]}
      variables={BLITZ_TEMPLATE_VARIABLES.map((variable) => ({
        name: variable.name, sample: variable.sample,
        label: variable.picker?.[language].label ?? variable.name,
        description: variable.picker?.[language].description ?? variable.name,
      }))} />
  </div>;
}
