import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, EmptyState, ListDetail, ListRow, ListToolbar, LoadState, QueryErrorState, SegmentedControl, SubInspector, notify } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, type ChatVote, type ChatVoteTemplate } from "../contracts";
import { rankVoteTerms, templateStartProblem } from "../domain";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateList } from "./template-list";
import { ChatVoteTemplateInspector } from "./template-inspector";
import type { TemplateInspectorActions } from "./template-inspector";
import type { ChatVotingPanelState } from "./service";
import { approveChatVotingTerm, closeChatVoting, deleteChatVoteTemplate, laterUsageTime, loadChatVotingState, loadChatVoteTemplates, loadRecentChatVotes, mergeChatVoteTemplateLists, startChatVoting } from "./service";
import type { ChatVoteTemplateListState } from "./service";
import { compactDateRange, timeText } from "./date-range";
import { ChatVotingLiveBlock } from "./live-block";
import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";

type ListMode = "saved" | "recent";
type Announcement = { key: number; text: string };
const EMPTY_TEMPLATES: readonly ChatVoteTemplate[] = [];
const voteTotal = (vote: ChatVote): number => vote.kind === "free_text"
  ? vote.voterCount ?? (vote.textResults ?? []).reduce((sum, term) => sum + term.count, 0)
  : vote.voterCount ?? (vote.counts ?? []).reduce((sum, count) => sum + count, 0);

const winnerFor = (vote: ChatVote, labels: ReturnType<typeof chatVotingSavedPanelTexts>): string => {
  if (vote.kind === "free_text") {
    const leader = rankVoteTerms((vote.textResults ?? []).filter((term) => term.approved), 1)[0];
    if (leader === undefined) return labels.noWinner;
    const total = (vote.textResults ?? []).reduce((sum, term) => sum + term.count, 0);
    return labels.winner(leader.term, total === 0 ? 0 : Math.round(leader.count * 100 / total));
  }
  const counts = vote.counts ?? [];
  const maximum = Math.max(0, ...counts);
  if (maximum === 0) return labels.noWinner;
  const index = counts.findIndex((count) => count === maximum);
  const answer = vote.labels[index] ?? String(index + 1);
  const total = counts.reduce((sum, count) => sum + count, 0);
  return labels.winner(answer, total === 0 ? 0 : Math.round(maximum * 100 / total));
};

const lockReason = (
  state: ChatVotingPanelState | null,
  canOperate: boolean,
  labels: ReturnType<typeof chatVotingSavedPanelTexts>,
  unavailableReason: string | null,
): string | null => {
  if (!canOperate) return labels.operatorLocked;
  if (unavailableReason !== null) return unavailableReason;
  if (state === null) return labels.loading;
  if (state.vote?.status === "open") return labels.runningLocked;
  if (state.hasOpenBallot) return labels.votekickLocked;
  return null;
};

export const ChatVotingPanel = (properties: ModulePanelProperties): ReactElement =>
  <ChatVotingPanelForChannel key={properties.channelId} {...properties} />;

const ChatVotingPanelForChannel = ({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement => {
  const labels = chatVotingSavedPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const fallbackRefetchInterval = realtimeStatus === "connected" ? false : 2_000;
  const [mode, setMode] = useState<ListMode>("saved");
  const loadErrorsNotified = useRef({ vote: false, templates: false, recent: false });
  const stateQuery = useModuleQuery(channelId, "chat_voting", "panel", async (signal) => {
    try {
      const current = await loadChatVotingState(channelId, signal);
      loadErrorsNotified.current.vote = false;
      return current;
    } catch (failure: unknown) {
      if (!signal.aborted && !loadErrorsNotified.current.vote) {
        loadErrorsNotified.current.vote = true;
        notify({ tone: "error", message: labels.liveLoadError });
      }
      throw failure;
    }
  }, { refetchInterval: fallbackRefetchInterval });
  const templatesQuery = useModuleQuery(channelId, "chat_voting", "templates", async (signal) => {
    try {
      const current = mergeChatVoteTemplateLists(
        queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates")) ?? null,
        await loadChatVoteTemplates(channelId, signal),
      );
      loadErrorsNotified.current.templates = false;
      return current;
    } catch (failure: unknown) {
      if (!signal.aborted && !loadErrorsNotified.current.templates) {
        loadErrorsNotified.current.templates = true;
        notify({ tone: "error", message: labels.templatesError });
      }
      throw failure;
    }
  }, { refetchInterval: fallbackRefetchInterval });
  const recentQuery = useModuleQuery(channelId, "chat_voting", "recent", async (signal) => {
    try {
      const current = await loadRecentChatVotes(channelId, signal);
      loadErrorsNotified.current.recent = false;
      return current;
    } catch (failure: unknown) {
      if (!signal.aborted && !loadErrorsNotified.current.recent) {
        loadErrorsNotified.current.recent = true;
        notify({ tone: "error", message: labels.recentError });
      }
      throw failure;
    }
  }, { enabled: mode === "recent", refetchInterval: fallbackRefetchInterval });
  const voteState = stateQuery.data ?? null;
  const templateList = templatesQuery.data ?? null;
  const recentState = recentQuery.data ?? null;
  const recentVotes = recentState?.votes ?? null;
  const [voteFailureData, setVoteFailureData] = useState<ChatVotingPanelState | null | "none">("none");
  const [templateFailureData, setTemplateFailureData] = useState<ChatVoteTemplateListState | null | "none">("none");
  const [recentFailureData, setRecentFailureData] = useState<{ votes: readonly ChatVote[] } | null | "none">("none");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateSnapshot, setTemplateSnapshot] = useState<ChatVoteTemplate | null>(null);
  const [templateInspectorKey, setTemplateInspectorKey] = useState<string | null>(null);
  const [templateInspectorGeneration, setTemplateInspectorGeneration] = useState(0);
  const [newTemplateDraft, setNewTemplateDraft] = useState<ChatVoteTemplate | null>(null);
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null);
  const [selectedRecentId, setSelectedRecentId] = useState<string | null>(null);
  const [selectionCleared, setSelectionCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const announcementSequence = useRef(0);
  const selectedTemplateIdRef = useRef<string | null>(null);
  const templateSnapshotRef = useRef<ChatVoteTemplate | null>(null);
  const templateInspectorKeyRef = useRef<string | null>(null);
  const templateInspectorGenerationRef = useRef(0);
  const selectionClearedRef = useRef(selectionCleared);
  const previousVote = useRef<{ id: string; status: "open" | "closed"; title: string | null } | null>(null);
  const newDraftSequence = useRef(0);
  const inspectorActions = useRef<TemplateInspectorActions | null>(null);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280);
  const templates = templateList?.templates ?? EMPTY_TEMPLATES;

  const updateTemplateSelection = useCallback((id: string | null, snapshot: ChatVoteTemplate | null, inspectorKey = id): void => {
    if (templateInspectorKeyRef.current !== inspectorKey) {
      const generation = templateInspectorGenerationRef.current + 1;
      templateInspectorGenerationRef.current = generation;
      setTemplateInspectorGeneration(generation);
    }
    selectedTemplateIdRef.current = id;
    templateSnapshotRef.current = snapshot;
    templateInspectorKeyRef.current = inspectorKey;
    setSelectedTemplateId(id);
    setTemplateSnapshot(snapshot);
    setTemplateInspectorKey(inspectorKey);
  }, []);
  const requestInspectorSwitch = useCallback((proceed: () => void): void => {
    const guardSwitch = inspectorActions.current?.guardSwitch;
    if (guardSwitch === undefined) proceed();
    else guardSwitch(proceed);
  }, []);
  const registerInspectorActions = useCallback((actions: TemplateInspectorActions | null): void => {
    inspectorActions.current = actions;
  }, []);

  useEffect(() => {
    if (mode !== "saved" || !wide || selectionCleared || selectedTemplateId !== null || templateSnapshot !== null || newTemplateDraft !== null) return;
    const firstTemplate = templates[0];
    if (firstTemplate === undefined) return;
    requestInspectorSwitch(() => {
      if (selectedTemplateIdRef.current !== null || selectionClearedRef.current) return;
      updateTemplateSelection(firstTemplate.id, firstTemplate);
    });
  }, [mode, newTemplateDraft, requestInspectorSwitch, selectedTemplateId, selectionCleared, templateSnapshot, templates, updateTemplateSelection, wide]);

  const refreshVote = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVotingPanelState>(queryClient, channelId, "chat_voting", "panel");
      setVoteFailureData("none");
    } catch {
      setVoteFailureData(voteState);
      if (voteState === null && !loadErrorsNotified.current.vote) {
        loadErrorsNotified.current.vote = true;
        notify({ tone: "error", message: labels.liveLoadError });
      }
    }
  }, [channelId, labels.liveLoadError, queryClient, voteState]);

  const refreshTemplates = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVoteTemplateListState>(queryClient, channelId, "chat_voting", "templates");
      setTemplateFailureData("none");
    } catch {
      setTemplateFailureData(templateList);
      if (templateList === null && !loadErrorsNotified.current.templates) {
        loadErrorsNotified.current.templates = true;
        notify({ tone: "error", message: labels.templatesError });
      }
    }
  }, [channelId, labels.templatesError, queryClient, templateList]);

  const refreshRecent = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<{ votes: readonly ChatVote[] }>(queryClient, channelId, "chat_voting", "recent");
      setRecentFailureData("none");
    } catch {
      setRecentFailureData(recentState);
      if (recentVotes === null && !loadErrorsNotified.current.recent) {
        loadErrorsNotified.current.recent = true;
        notify({ tone: "error", message: labels.recentError });
      }
    }
  }, [channelId, labels.recentError, queryClient, recentState, recentVotes]);

  useEffect(() => {
    const resize = (): void => {
      const nextWide = window.innerWidth >= 1280;
      setWide(nextWide);
    };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); };
  }, []);

  useEffect(() => {
    if (voteState === null) return;
    const current = voteState.vote;
    const previous = previousVote.current;
    if (previous === null && current?.status === "open") {
      announcementSequence.current += 1;
      setAnnouncement({ key: announcementSequence.current, text: labels.startAnnouncement(current.title || labels.untitled) });
    } else if (previous !== null && previous.status !== "open" && current?.status === "open") {
      announcementSequence.current += 1;
      setAnnouncement({ key: announcementSequence.current, text: labels.startAnnouncement(current.title || labels.untitled) });
    } else if (previous?.status === "open" && current?.status !== "open") {
      announcementSequence.current += 1;
      setAnnouncement({ key: announcementSequence.current, text: labels.endAnnouncement(previous.title || labels.untitled) });
    }
    const voteClosedOrReplaced = previous?.status === "open" && (current?.status !== "open" || current.id !== previous.id);
    const newlyObservedClosedVote = current?.status === "closed" && (previous === null || current.id !== previous.id);
    if (voteClosedOrReplaced || newlyObservedClosedVote) {
      if (mode === "recent") void refreshRecent();
    }
    previousVote.current = current === null ? null : { id: current.id, status: current.status, title: current.title };
  }, [labels, mode, refreshRecent, voteState]);

  const voteError = stateQuery.isError || (voteFailureData !== "none" && voteFailureData === voteState);
  const templateError = templatesQuery.isError || (templateFailureData !== "none" && templateFailureData === templateList);
  const recentError = recentQuery.isError || (recentFailureData !== "none" && recentFailureData === recentState);
  const activeLockReason = lockReason(voteState, canOperate, labels,
    voteError ? labels.liveLoadError : voteState === null ? labels.loading : null);
  const selectedTemplate = mode === "saved"
    ? newTemplateDraft ?? (templateSnapshot !== null && (selectedTemplateId === null || templateSnapshot.id === selectedTemplateId)
      ? templateSnapshot
      : wide && !selectionCleared && selectedTemplateId === null ? templates[0] ?? null : null)
    : null;
  const selectedRecent = mode === "recent"
    ? recentVotes?.find((vote) => vote.id === selectedRecentId) ?? (wide && !selectionCleared ? recentVotes?.[0] ?? null : null)
    : null;
  const count = templateList?.count ?? templates.length;
  const defaultDuration = voteState?.defaultDurationSeconds ?? 120;
  const createBlocked = count >= CHAT_VOTE_TEMPLATE_MAXIMUM;

  const selectTemplate = (template: ChatVoteTemplate): void => {
    requestInspectorSwitch(() => {
      const latest = queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates"));
      const selectedSnapshot = latest?.templates.find((entry) => entry.id === template.id) ?? template;
      const reselecting = selectedTemplateIdRef.current === template.id;
      const refreshed = reselecting && templateSnapshotRef.current?.revision !== selectedSnapshot.revision;
      selectionClearedRef.current = false;
      setSelectionCleared(false);
      setSelectedRecentId(null);
      const inspectorKey = reselecting
        ? templateInspectorKeyRef.current ?? template.id
        : template.id;
      updateTemplateSelection(template.id, selectedSnapshot, inspectorKey);
      if (refreshed) inspectorActions.current?.acceptTemplate(selectedSnapshot);
      setNewTemplateDraft(null);
      setSavedTemplateId(null);
    });
  };

  const selectRecent = (vote: ChatVote): void => {
    requestInspectorSwitch(() => {
      selectionClearedRef.current = false;
      setSelectionCleared(false);
      updateTemplateSelection(null, null);
      setNewTemplateDraft(null);
      setSavedTemplateId(null);
      setSelectedRecentId(vote.id);
    });
  };

  const clearInspector = (): void => {
    selectionClearedRef.current = true;
    setSelectionCleared(true);
    updateTemplateSelection(null, null);
    setNewTemplateDraft(null);
    setSavedTemplateId(null);
    setSelectedRecentId(null);
  };

  const closeInspector = (): void => { requestInspectorSwitch(clearInspector); };

  const changeMode = (value: string): void => {
    requestInspectorSwitch(() => {
      const next = value as ListMode;
      if (next === "recent") void refreshRecent();
      setSelectionCleared(false);
      selectionClearedRef.current = false;
      setMode(next);
      const firstTemplate = next === "saved" && wide ? templates[0] ?? null : null;
      updateTemplateSelection(firstTemplate?.id ?? null, firstTemplate);
      setNewTemplateDraft(null);
      setSavedTemplateId(null);
      setSelectedRecentId(next === "recent" && wide ? recentVotes?.[0]?.id ?? null : null);
    });
  };

  const createTemplate = (): void => {
    if (count >= CHAT_VOTE_TEMPLATE_MAXIMUM) return;
    requestInspectorSwitch(() => {
      const now = new Date().toISOString();
      const id = `new-${String(++newDraftSequence.current)}`;
      const template: ChatVoteTemplate = {
        id, channelId, shortcut: null, title: "", labels: [], freeTextMode: null,
        durationSeconds: defaultDuration, revision: 0, legacyAlias: null, lastUsedAt: null,
        createdAt: now, updatedAt: now,
      };
      selectionClearedRef.current = false;
      setMode("saved");
      setSelectedRecentId(null);
      updateTemplateSelection(id, null);
      setNewTemplateDraft(template);
      setSavedTemplateId(null);
      setSelectionCleared(false);
    });
  };

  const startTemplate = async (template: ChatVoteTemplate): Promise<void> => {
    if (pendingTemplateId !== null || activeLockReason !== null) return;
    setPendingTemplateId(template.id);
    try {
      const problem = templateStartProblem(template);
      if (problem !== null) return;
      const started = await runModuleQueryWrite(queryClient, channelId, "chat_voting", "templates",
        () => startChatVoting(channelId, { templateId: template.id }), {
          baselineRevision: template.revision,
          updateCache: (current, vote) => {
            if (current === undefined) return current;
            const previous = current as ChatVoteTemplateListState;
            const cachedTemplate = previous.templates.find((entry) => entry.id === template.id);
            if (cachedTemplate === undefined) return previous;
            const updated = { ...cachedTemplate, lastUsedAt: laterUsageTime(cachedTemplate.lastUsedAt, vote.openedAt) };
            return {
              ...previous,
              templates: previous.templates.map((entry) => entry.id === template.id ? updated : entry),
            };
          },
        });
      const latest = queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates"))
        ?.templates.find((entry) => entry.id === template.id);
      const selectedSnapshot = templateSnapshotRef.current;
      if (selectedTemplateIdRef.current === template.id && selectedSnapshot?.id === template.id) {
        const updatedSnapshot = {
          ...selectedSnapshot,
          lastUsedAt: laterUsageTime(selectedSnapshot.lastUsedAt, latest?.lastUsedAt ?? started.openedAt),
        };
        templateSnapshotRef.current = updatedSnapshot;
        setTemplateSnapshot(updatedSnapshot);
      }
      void refreshVote();
    } catch (error: unknown) {
      const message = error instanceof PanelApiError && error.code === "chat_voting_busy"
        ? labels.runningLocked
        : error instanceof PanelApiError && error.code === "chat_vote_template_invalid"
          ? labels.problem(error.details !== null && typeof error.details === "object" && "problem" in error.details && error.details.problem === "duration" ? "duration" : "answers")
          : labels.startError;
      notify({ tone: "error", message });
    } finally {
      setPendingTemplateId(null);
    }
  };

  const startRecent = async (vote: ChatVote): Promise<void> => {
    if (busy || activeLockReason !== null) return;
    setBusy(true);
    try {
      await startChatVoting(channelId, {
        kind: vote.kind,
        ...(vote.kind === "free_text" ? {} : { optionCount: vote.optionCount, labels: vote.labels }),
        ...(vote.kind === "free_text" ? { textMode: vote.textMode ?? "first_word" } : {}),
        durationSeconds: vote.requestedDurationSeconds ?? 0,
        ...(vote.title === null ? {} : { title: vote.title }),
      });
      void refreshVote();
    } catch {
      notify({ tone: "error", message: labels.startError });
    } finally {
      setBusy(false);
    }
  };

  const closeVote = async (): Promise<void> => {
    if (busy || !canOperate) return;
    setBusy(true);
    try {
      await closeChatVoting(channelId);
      await refreshVote();
    } catch {
      notify({ tone: "error", message: labels.endError });
    } finally {
      setBusy(false);
    }
  };

  const approveTerm = async (pollId: string, term: string): Promise<void> => {
    if (busy || !canOperate) return;
    setBusy(true);
    try {
      await approveChatVotingTerm(channelId, pollId, term);
      notify({ tone: "success", message: labels.approvalSaved });
      await refreshVote();
    } catch (error: unknown) {
      const message = error instanceof PanelApiError && error.code === "chat_voting_blocked_terms_unavailable"
        ? labels.termsUnavailable : labels.approvalFailed;
      notify({ tone: "error", message });
    } finally {
      setBusy(false);
    }
  };

  const removeTemplate = async (template: ChatVoteTemplate): Promise<void> => {
    try {
      const nextSelection: { template: ChatVoteTemplate | null } = { template: null };
      await runModuleQueryWrite(queryClient, channelId, "chat_voting", "templates", () => deleteChatVoteTemplate(channelId, template), {
        baselineRevision: template.revision,
        updateCache: (current) => {
          if (current === undefined) return current;
          const previous = current as ChatVoteTemplateListState;
          const position = previous.templates.findIndex((entry) => entry.id === template.id);
          const remaining = previous.templates.filter((entry) => entry.id !== template.id);
          nextSelection.template = remaining[position < 0 ? 0 : position] ?? remaining.at(-1) ?? null;
          return {
            ...previous,
            templates: remaining,
            count: Math.max(0, previous.count - (position < 0 ? 0 : 1)),
          };
        },
      });
      if (selectedTemplateIdRef.current === template.id) {
        requestInspectorSwitch(() => {
          if (selectedTemplateIdRef.current !== template.id) return;
          updateTemplateSelection(nextSelection.template?.id ?? null, nextSelection.template);
          setNewTemplateDraft(null);
          setSavedTemplateId(null);
          selectionClearedRef.current = nextSelection.template === null;
          setSelectionCleared(nextSelection.template === null);
        });
      }
    } catch {
      notify({ tone: "error", message: labels.deleteError });
      throw new Error(labels.deleteError);
    }
  };

  const onTemplateSaved = (template: ChatVoteTemplate, originGeneration: number): void => {
    if (originGeneration !== templateInspectorGenerationRef.current) return;
    const inspectorKey = templateInspectorKeyRef.current ?? template.id;
    updateTemplateSelection(template.id, template, inspectorKey);
    setNewTemplateDraft(null);
    setSavedTemplateId(template.id);
    selectionClearedRef.current = false;
    setSelectionCleared(false);
  };

  const discardNewTemplate = (): void => { clearInspector(); };

  const startFromTemplateList = (template: ChatVoteTemplate): void => {
    if (selectedTemplate?.id === template.id && inspectorActions.current !== null) {
      void inspectorActions.current.start();
      return;
    }
    void startTemplate(template);
  };

  const liveStatus = voteState === null
    ? voteError ? "error" : "loading"
    : "success";
  const listStatus = mode === "saved"
    ? templateList === null ? templateError ? "error" : "loading" : templates.length === 0 ? "empty" : "success"
    : recentVotes === null ? recentError ? "error" : "loading" : recentVotes.length === 0 ? "empty" : "success";

  const liveLoading = <div className="chat-voting-live__load-text">{labels.loading}</div>;
  const liveEmpty = <div className="chat-voting-live__empty"><EmptyState title={labels.noVoteYet} description="" /></div>;
  const liveError = <QueryErrorState title={labels.liveLoadError} reason={labels.liveLoadError} retryLabel={labels.retry} onRetry={() => { void refreshVote(); }} />;
  const loadListStatus = listStatus;
  const listLoading = <div className="chat-voting-list__load-text">{labels.loading}</div>;
  const emptySaved = <EmptyState title={labels.emptySaved} description={labels.emptySavedDescription} action={{ label: labels.create, onClick: createTemplate }} />;
  const emptyRecent = <EmptyState title={labels.emptyRecent} description="" />;
  const listError = mode === "saved"
    ? <QueryErrorState title={labels.templatesError} reason={labels.templatesError} retryLabel={labels.retry} onRetry={() => { void refreshTemplates(); }} />
    : <QueryErrorState title={labels.recentError} reason={labels.recentError} retryLabel={labels.retry} onRetry={() => { void refreshRecent(); }} />;

  const templateInspector = selectedTemplate === null ? null : <ChatVoteTemplateInspector
    key={templateInspectorKey ?? selectedTemplate.id}
    channelId={channelId}
    template={selectedTemplate}
    templates={templates}
    isNew={newTemplateDraft?.id === selectedTemplate.id}
    initiallySaved={savedTemplateId === selectedTemplate.id}
    language={language}
    isRunning={voteState?.vote?.status === "open" && (templates.find((entry) => entry.id === selectedTemplate.id)?.lastUsedAt ?? selectedTemplate.lastUsedAt) === voteState.vote.openedAt}
    startLockReason={activeLockReason}
    onRegisterActions={registerInspectorActions}
    onTemplateSaved={(template) => { onTemplateSaved(template, templateInspectorGeneration); }}
    onClose={clearInspector}
    onDiscardNew={discardNewTemplate}
    onStart={startTemplate}
    onDelete={removeTemplate}
  />;

  const recentInspector = selectedRecent === null ? null : <SubInspector
    ariaLabel={labels.recent}
    title={selectedRecent.title || labels.untitled}
    closeLabel={labels.cancel}
    onClose={closeInspector}
    className="chat-voting-recent-inspector"
  >
    <InspectorSectionView title={labels.answers}>
      {selectedRecent.kind === "free_text"
        ? rankVoteTerms((selectedRecent.textResults ?? []).filter((term) => term.approved)).map((term) => {
          const total = (selectedRecent.textResults ?? []).reduce((sum, item) => sum + item.count, 0);
          const percent = total === 0 ? 0 : Math.round(term.count * 100 / total);
          return <ResultBar key={term.term} label={term.term} count={term.count} percent={percent} leader={false} />;
        })
        : (selectedRecent.labels).map((answer, index) => {
          const counts = selectedRecent.counts ?? [];
          const total = counts.reduce((sum, value) => sum + value, 0);
          const amount = counts[index] ?? 0;
          const percent = total === 0 ? 0 : Math.round(amount * 100 / total);
          return <ResultBar key={String(index)} label={answer} count={amount} percent={percent} leader={amount === Math.max(0, ...counts)} />;
        })}
    </InspectorSectionView>
    {(() => {
      const [started, ended] = compactDateRange(selectedRecent.openedAt, selectedRecent.closedAt ?? selectedRecent.closesAt, language, labels.nextDay);
      return <p className="chat-voting-recent-inspector__meta">{labels.closeReason(selectedRecent.closeReason)} · {started} – {ended}</p>;
    })()}
    <div className="chat-voting-recent-inspector__footer">
      <Button variant="neutral" disabled={activeLockReason !== null || busy} onClick={() => { void startRecent(selectedRecent); }}>{labels.repeat}</Button>
      {activeLockReason ? <span className="chat-voting-editor__start-reason">{activeLockReason}</span> : null}
    </div>
  </SubInspector>;

  const inspector = mode === "saved" ? templateInspector : recentInspector;

  return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <div className={voteError && voteState !== null ? "stale" : undefined}>
      <LoadState
        status={liveStatus}
        minHeight="var(--chat-voting-live-height)"
        loading={liveLoading}
        empty={liveEmpty}
        error={liveError}
      >
        <ChatVotingLiveBlock
          state={voteState}
          language={language}
          busy={busy}
          canOperate={canOperate}
          onClose={() => { void closeVote(); }}
          onApprove={(pollId, term) => { void approveTerm(pollId, term); }}
        />
      </LoadState>
    </div>

    <ListDetail list={
      <section className="chat-voting-list" aria-label={labels.title}>
        <ListToolbar
          filters={<SegmentedControl
            label={labels.title}
            value={mode}
            onChange={changeMode}
            options={[{ value: "saved", label: labels.saved }, { value: "recent", label: labels.recent }]}
            size="form"
          />}
          filtersLabel={labels.title}
          create={{
            label: labels.create,
            disabled: createBlocked || busy,
            ...(createBlocked ? { reason: labels.templateLimit } : {}),
            onClick: createTemplate,
          }}
          usage={{
            count,
            maximum: CHAT_VOTE_TEMPLATE_MAXIMUM,
            copy: { countSuffix: "", filteredInfix: "", filteredSuffix: "", limitInfix: "/", limitSuffix: "", loadedSuffix: "" },
          }}
          activeFilters={activeLockReason ?? ""}
        />
        <LoadState
          status={loadListStatus}
          minHeight={320}
          loading={listLoading}
          empty={mode === "saved" ? emptySaved : emptyRecent}
          error={listError}
        >
          {mode === "saved" ? <div className={templateError ? "stale" : undefined}><ChatVoteTemplateList
            templates={templates}
            selectedId={selectedTemplate?.id ?? null}
            vote={voteState?.vote ?? null}
            startsLockedReason={activeLockReason}
            canOperate={canOperate}
            pendingId={pendingTemplateId}
            labels={labels}
            durationText={(seconds) => chatVoteDurationText(seconds, language)}
            onSelect={selectTemplate}
            onStart={startFromTemplateList}
          /></div> : <div className={recentError ? "stale" : undefined}><div className="chat-voting-recent-list">
            {(recentVotes ?? []).map((vote) => {
              const title = vote.title || labels.untitled;
              const time = timeText(vote.closedAt ?? vote.openedAt, language);
              const total = voteTotal(vote);
              const winner = winnerFor(vote, labels);
              return <ListRow
                key={vote.id}
                href={"#recent-" + encodeURIComponent(vote.id)}
                onNavigate={() => { selectRecent(vote); }}
                title={title}
                description={<span><span className="mono">{time} · {String(total)}</span> {labels.voteWord} · {winner}</span>}
                selected={vote.id === selectedRecent?.id}
                status={null}
                action={<Button
                  icon="player-play"
                  iconOnly
                  size="compact"
                  ariaLabel={labels.repeat + ": " + title}
                  title={activeLockReason ?? labels.repeat}
                  disabled={activeLockReason !== null || busy}
                  onClick={() => { void startRecent(vote); }}
                />}
              />;
            })}
          </div></div>}
        </LoadState>
      </section>
    } inspector={inspector} onCloseInspector={closeInspector} />

    <div className="sr-only" aria-live="polite" key={announcement?.key ?? 0}>{announcement?.text ?? ""}</div>
  </section>;
};

const InspectorSectionView = ({ title, children }: { title: string; children: ReactNode }): ReactElement =>
  <section className="inspector-content-section"><h3 className="inspector-content-section__heading">{title}</h3><div className="inspector-content-section__body">{children}</div></section>;

const ResultBar = ({ label, count, percent, leader }: { label: string; count: number; percent: number; leader: boolean }): ReactElement =>
  <div className="chat-voting-results__row" data-leading={leader || undefined} role="group" aria-label={label + ": " + String(count) + ", " + String(percent) + "%"}>
    <span className="chat-voting-results__label" title={label}>{label}</span>
    <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: String(percent) + "%" }} /></span>
    <span className="number">{String(count)}</span>
    <span className="number">{String(percent)}%</span>
  </div>;

export default ChatVotingPanel;
