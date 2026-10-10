import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, EmptyState, Icon, ListDetail, ListRow, ListToolbar, LoadState, QueryErrorState, SegmentedControl, notify } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { CHAT_VOTE_TEMPLATE_MAXIMUM, type ChatVote, type ChatVoteTemplate } from "../contracts";
import { rankVoteTerms, templateStartProblem } from "../domain";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateList } from "./template-list";
import { ChatVoteTemplateInspector } from "./template-inspector";
import type { TemplateInspectorActions } from "./template-inspector";
import type { ChatVotingPanelState } from "./service";
import { approveChatVotingTerm, closeChatVoting, deleteChatVoteTemplate, loadChatVotingState, loadChatVoteTemplates, loadRecentChatVotes, mergeChatVoteTemplateLists, startChatVoting } from "./service";
import type { ChatVoteTemplateListState } from "./service";
import { compactDateRange, timeText } from "./date-range";
import { ChatVotingLiveBlock } from "./live-block";

type ListMode = "saved" | "recent";
type Announcement = { key: number; text: string };
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
  const [voteState, setVoteState] = useState<ChatVotingPanelState | null>(null);
  const [voteError, setVoteError] = useState(false);
  const [templateList, setTemplateList] = useState<ChatVoteTemplateListState | null>(null);
  const [templateError, setTemplateError] = useState(false);
  const [recentVotes, setRecentVotes] = useState<readonly ChatVote[] | null>(null);
  const [recentError, setRecentError] = useState(false);
  const [mode, setMode] = useState<ListMode>("saved");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [templateSnapshot, setTemplateSnapshot] = useState<ChatVoteTemplate | null>(null);
  const [templateInspectorKey, setTemplateInspectorKey] = useState<string | null>(null);
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
  const modeRef = useRef(mode);
  const selectionClearedRef = useRef(selectionCleared);
  const previousVote = useRef<{ id: string; status: "open" | "closed"; title: string | null } | null>(null);
  const recentRequestSequence = useRef(0);
  const voteRequestSequence = useRef(0);
  const templateRequestSequence = useRef(0);
  const voteAppliedSequence = useRef(0);
  const recentAppliedSequence = useRef(0);
  const templateAppliedSequence = useRef(0);
  const newDraftSequence = useRef(0);
  const inspectorActions = useRef<TemplateInspectorActions | null>(null);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1280);
  const templates = useMemo(() => templateList?.templates ?? [], [templateList]);
  const voteRef = useRef(voteState);
  const templateListRef = useRef(templateList);
  const recentVotesRef = useRef(recentVotes);
  useEffect(() => { voteRef.current = voteState; }, [voteState]);
  useEffect(() => { templateListRef.current = templateList; }, [templateList]);
  useEffect(() => { recentVotesRef.current = recentVotes; }, [recentVotes]);

  const updateTemplateSelection = useCallback((id: string | null, snapshot: ChatVoteTemplate | null, inspectorKey = id): void => {
    selectedTemplateIdRef.current = id;
    templateSnapshotRef.current = snapshot;
    templateInspectorKeyRef.current = inspectorKey;
    setSelectedTemplateId(id);
    setTemplateSnapshot(snapshot);
    setTemplateInspectorKey(inspectorKey);
  }, []);
  const maybeSelectDefaultTemplate = useCallback((available: readonly ChatVoteTemplate[], isWide = wide): void => {
    const first = available[0];
    if (isWide && modeRef.current === "saved" && !selectionClearedRef.current &&
        selectedTemplateIdRef.current === null && templateSnapshotRef.current === null && first !== undefined) {
      updateTemplateSelection(first.id, first);
    }
  }, [updateTemplateSelection, wide]);

  const replaceTemplate = useCallback((updated: ChatVoteTemplate): void => {
    setTemplateList((current) => current === null ? current : {
      ...current,
      templates: current.templates.map((template) => template.id === updated.id ? updated : template),
    });
    if (templateSnapshotRef.current?.id === updated.id) {
      templateSnapshotRef.current = updated;
      setTemplateSnapshot(updated);
    }
  }, []);
  const requestInspectorSwitch = useCallback((proceed: () => void): void => {
    const guardSwitch = inspectorActions.current?.guardSwitch;
    if (guardSwitch === undefined) proceed();
    else guardSwitch(proceed);
  }, []);
  const registerInspectorActions = useCallback((actions: TemplateInspectorActions | null): void => {
    inspectorActions.current = actions;
  }, []);

  const refreshVote = useCallback(async (): Promise<void> => {
    const requestSequence = ++voteRequestSequence.current;
    try {
      const next = await loadChatVotingState(channelId);
      if (requestSequence <= voteAppliedSequence.current) return;
      voteAppliedSequence.current = requestSequence;
      setVoteState(next);
      setVoteError(false);
    } catch {
      if (requestSequence <= voteAppliedSequence.current) return;
      voteAppliedSequence.current = requestSequence;
      setVoteError(true);
      if (voteRef.current === null) notify({ tone: "error", message: labels.liveLoadError });
    }
  }, [channelId, labels.liveLoadError]);

  const refreshTemplates = useCallback(async (): Promise<void> => {
    const requestSequence = ++templateRequestSequence.current;
    try {
      const next = await loadChatVoteTemplates(channelId);
      if (requestSequence <= templateAppliedSequence.current) return;
      templateAppliedSequence.current = requestSequence;
      setTemplateList((current) => mergeChatVoteTemplateLists(current, next));
      maybeSelectDefaultTemplate(next.templates);
      setTemplateError(false);
    } catch {
      if (requestSequence <= templateAppliedSequence.current) return;
      templateAppliedSequence.current = requestSequence;
      setTemplateError(true);
      if (templateListRef.current === null) notify({ tone: "error", message: labels.templatesError });
    }
  }, [channelId, labels.templatesError, maybeSelectDefaultTemplate]);

  const refreshRecent = useCallback(async (): Promise<void> => {
    const requestSequence = ++recentRequestSequence.current;
    try {
      const next = await loadRecentChatVotes(channelId);
      if (requestSequence <= recentAppliedSequence.current) return;
      recentAppliedSequence.current = requestSequence;
      setRecentVotes(next.votes);
      setRecentError(false);
    } catch {
      if (requestSequence <= recentAppliedSequence.current) return;
      recentAppliedSequence.current = requestSequence;
      setRecentError(true);
      if (recentVotesRef.current === null) notify({ tone: "error", message: labels.recentError });
    }
  }, [channelId, labels.recentError]);

  const refreshTemplateUsage = useCallback(async (): Promise<void> => {
    const requestSequence = ++templateRequestSequence.current;
    try {
      const latest = await loadChatVoteTemplates(channelId);
      if (requestSequence <= templateAppliedSequence.current) return;
      templateAppliedSequence.current = requestSequence;
      setTemplateList((current) => mergeChatVoteTemplateLists(current, latest));
      maybeSelectDefaultTemplate(latest.templates);
      setTemplateError(false);
    } catch {
      if (requestSequence <= templateAppliedSequence.current) return;
      templateAppliedSequence.current = requestSequence;
      setTemplateError(true);
      if (templateListRef.current === null) notify({ tone: "error", message: labels.templatesError });
    }
  }, [channelId, labels.templatesError, maybeSelectDefaultTemplate]);

  useEffect(() => {
    const resize = (): void => {
      const nextWide = window.innerWidth >= 1280;
      setWide(nextWide);
      if (nextWide) maybeSelectDefaultTemplate(templateListRef.current?.templates ?? [], true);
    };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); };
  }, [maybeSelectDefaultTemplate]);

  useEffect(() => {
    previousVote.current = null;
    const initialLoad = window.setTimeout(() => {
      void refreshVote();
      void refreshTemplates();
    }, 0);
    const poll = (): void => {
      if (document.visibilityState === "visible") void refreshVote();
    };
    const timer = window.setInterval(poll, 2_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [channelId, refreshTemplates, refreshVote]);

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
    const newlyOpened = current?.status === "open" &&
      (previous === null || previous.status !== "open" || previous.id !== current.id);
    if (newlyOpened) void refreshTemplateUsage();
    const voteClosedOrReplaced = previous?.status === "open" && (current?.status !== "open" || current.id !== previous.id);
    const newlyObservedClosedVote = current?.status === "closed" && (previous === null || current.id !== previous.id);
    if (voteClosedOrReplaced || newlyObservedClosedVote) {
      recentRequestSequence.current += 1;
      recentAppliedSequence.current = recentRequestSequence.current;
      setRecentVotes(null);
      setRecentError(false);
      if (mode === "recent") void refreshRecent();
    }
    previousVote.current = current === null ? null : { id: current.id, status: current.status, title: current.title };
  }, [labels, mode, refreshRecent, refreshTemplateUsage, voteState]);

  const activeLockReason = lockReason(voteState, canOperate, labels,
    voteError ? labels.liveLoadError : voteState === null ? labels.loading : null);
  const selectedTemplate = mode === "saved"
    ? newTemplateDraft ?? (templateSnapshot !== null && (selectedTemplateId === null || templateSnapshot.id === selectedTemplateId) ? templateSnapshot : null) ??
      null
    : null;
  const selectedRecent = mode === "recent"
    ? recentVotes?.find((vote) => vote.id === selectedRecentId) ?? (wide && !selectionCleared ? recentVotes?.[0] ?? null : null)
    : null;
  const count = templateList?.count ?? templates.length;
  const defaultDuration = voteState?.defaultDurationSeconds ?? 120;
  const createBlocked = count >= CHAT_VOTE_TEMPLATE_MAXIMUM;

  const selectTemplate = (template: ChatVoteTemplate): void => {
    requestInspectorSwitch(() => {
      selectionClearedRef.current = false;
      setSelectionCleared(false);
      setSelectedRecentId(null);
      updateTemplateSelection(template.id, template);
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
      if (next === "recent") {
        setRecentError(false);
        void refreshRecent();
      }
      setSelectionCleared(false);
      selectionClearedRef.current = false;
      modeRef.current = next;
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
      modeRef.current = "saved";
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
      const started = await startChatVoting(channelId, { templateId: template.id });
      replaceTemplate({ ...template, lastUsedAt: started.openedAt });
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
      await deleteChatVoteTemplate(channelId, template);
      const position = templates.findIndex((entry) => entry.id === template.id);
      const remaining = templates.filter((entry) => entry.id !== template.id);
      const next = remaining[position < 0 ? 0 : position] ?? remaining.at(-1) ?? null;
      setTemplateList((current) => current === null ? current : {
        ...current,
        templates: current.templates.filter((entry) => entry.id !== template.id),
        count: Math.max(0, current.count - 1),
      });
      updateTemplateSelection(next?.id ?? null, next);
      setNewTemplateDraft(null);
      setSavedTemplateId(null);
      selectionClearedRef.current = next === null;
      setSelectionCleared(next === null);
    } catch {
      notify({ tone: "error", message: labels.deleteError });
      throw new Error(labels.deleteError);
    }
  };

  const onTemplateSaved = (template: ChatVoteTemplate, wasNew: boolean): void => {
    setTemplateList((current) => {
      const alreadyListed = current?.templates.some((entry) => entry.id === template.id) ?? false;
      const previous = current ?? { templates: [], count: 0, maximum: CHAT_VOTE_TEMPLATE_MAXIMUM };
      return {
        ...previous,
        templates: alreadyListed
          ? previous.templates.map((entry) => entry.id === template.id ? template : entry)
          : [template, ...previous.templates],
        count: wasNew && !alreadyListed ? previous.count + 1 : previous.count,
      };
    });
    const inspectorKey = wasNew ? templateInspectorKeyRef.current ?? template.id : template.id;
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
    onTemplateSaved={onTemplateSaved}
    onClose={clearInspector}
    onDiscardNew={discardNewTemplate}
    onStart={startTemplate}
    onDelete={removeTemplate}
  />;

  const recentInspector = selectedRecent === null ? null : <section className="command-inspector sub-inspector chat-voting-recent-inspector" aria-label={labels.recent}>
    <div className="section-heading">
      <h3>{selectedRecent.title || labels.untitled}</h3>
      <button className="button button--quiet inspector-close" type="button" aria-label={labels.cancel} onClick={closeInspector}><Icon name="close" size={20} /></button>
    </div>
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
  </section>;

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
