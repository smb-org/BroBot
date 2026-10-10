import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Led, notify } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../../contract";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateList } from "./template-list";
import { closeChatVoting, loadChatVotingState, loadChatVoteTemplates, startChatVoting, type ChatVotingPanelState, type ChatVoteTemplateListState } from "./service";
import { timeText } from "./date-range";

const ChatVotingImmediateAction = (properties: ModuleImmediateActionProperties): ReactElement =>
  <ChatVotingImmediateActionForChannel key={properties.channelId} {...properties} />;

const ChatVotingImmediateActionForChannel = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";
  const labels = chatVotingSavedPanelTexts(language);
  const [state, setState] = useState<ChatVotingPanelState | null>(null);
  const [templates, setTemplates] = useState<ChatVoteTemplateListState | null>(null);
  const [templateError, setTemplateError] = useState(false);
  const [currentError, setCurrentError] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const previousVote = useRef<{ id: string; status: "open" | "closed" } | null>(null);
  const voteRequestSequence = useRef(0);
  const templateRequestSequence = useRef(0);
  const vote = state?.vote ?? null;
  const running = vote?.status === "open";
  const lockReason = availabilityReason ?? (currentError
    ? labels.liveLoadError
    : state === null ? labels.loading : running ? labels.runningLocked : state.hasOpenBallot ? labels.votekickLocked : null);

  const refreshTemplates = useCallback(async (): Promise<void> => {
    const requestSequence = ++templateRequestSequence.current;
    try {
      const current = await loadChatVoteTemplates(channelId);
      if (requestSequence !== templateRequestSequence.current) return;
      const usageById = new Map(current.templates.map((template) => [template.id, template.lastUsedAt]));
      setTemplates((previous) => previous === null ? current : {
        ...previous,
        templates: previous.templates.map((template) => {
          const latestUsage = usageById.get(template.id) ?? null;
          const lastUsedAt = [template.lastUsedAt, latestUsage]
            .filter((value): value is string => value !== null)
            .sort((left, right) => left.localeCompare(right))
            .at(-1) ?? null;
          return { ...template, lastUsedAt };
        }),
      });
      setTemplateError(false);
    } catch {
      if (requestSequence !== templateRequestSequence.current) return;
      setTemplateError(true);
    }
  }, [channelId]);

  const refreshVote = useCallback(async (): Promise<void> => {
    const requestSequence = ++voteRequestSequence.current;
    try {
      const current = await loadChatVotingState(channelId);
      if (requestSequence !== voteRequestSequence.current) return;
      const nextVote = current.vote;
      const previous = previousVote.current;
      const newlyOpened = nextVote?.status === "open" &&
        (previous === null || previous.status !== "open" || previous.id !== nextVote.id);
      previousVote.current = nextVote === null ? null : { id: nextVote.id, status: nextVote.status };
      setState(current);
      setCurrentError(false);
      if (newlyOpened) void refreshTemplates();
    } catch {
      if (requestSequence !== voteRequestSequence.current) return;
      // Keep the last known live state visible while the template list loads independently.
      setCurrentError(true);
    }
  }, [channelId, refreshTemplates]);

  useEffect(() => {
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

  const start = async (template: NonNullable<ChatVoteTemplateListState>["templates"][number]): Promise<void> => {
    if (lockReason !== null || pendingId !== null) return;
    setPendingId(template.id);
    try {
      const started = await startChatVoting(channelId, { templateId: template.id });
      setTemplates((current) => current === null ? current : {
        ...current,
        templates: current.templates.map((entry) => entry.id === template.id
          ? { ...entry, lastUsedAt: started.openedAt }
          : entry),
      });
      await refreshVote();
    } catch (error: unknown) {
      notify({ tone: "error", message: error instanceof PanelApiError && error.code === "chat_voting_busy" ? labels.runningLocked : labels.startError });
    } finally {
      setPendingId(null);
    }
  };

  const end = async (): Promise<void> => {
    if (!running || ending) return;
    setEnding(true);
    try {
      await closeChatVoting(channelId);
      await refreshVote();
    } catch {
      notify({ tone: "error", message: labels.endError });
    } finally {
      setEnding(false);
    }
  };

  const reason = templateError
    ? labels.templatesError
    : templates === null
      ? labels.loading
      : templates.templates.length === 0
        ? labels.noTemplatesLocked
        : lockReason ?? "";
  const liveStatus = currentError ? labels.liveLoadError : state === null ? labels.loading : running ? labels.running : labels.idle;

  return <section className="stream-manager-action chat-voting-immediate" aria-label={labels.title}>
    <header className="chat-voting-immediate__header">
      <h3>{labels.title}</h3>
      <Led status={running ? "green" : "off"} word={liveStatus} />
      {running ? <Button danger size="compact" disabled={ending} onClick={() => { void end(); }}>{labels.end}</Button> : <span aria-hidden="true" />}
    </header>
    <div className="chat-voting-immediate__status">
      <span className="chat-voting-immediate__question" title={vote?.title ?? ""}>{vote?.title || labels.idle}</span>
      {running ? <span className="chat-voting-immediate__ending mono">{vote.requestedDurationSeconds === null ? labels.open : timeText(vote.closesAt, language)}</span> : null}
    </div>
    <div className="chat-voting-immediate__list" aria-label={labels.saved}>
      {templates === null && !templateError ? <p className="chat-voting-immediate__loading">{labels.loading}</p> : null}
      {templateError ? <button className="chat-voting-immediate__retry" type="button" onClick={() => { void refreshTemplates(); }}>{labels.retry}</button> : null}
      {templates !== null ? <ChatVoteTemplateList
        templates={templates.templates}
        vote={vote}
        startsLockedReason={lockReason}
        canOperate
        pendingId={pendingId}
        labels={labels}
        durationText={(seconds) => chatVoteDurationText(seconds, language)}
        onSelect={() => undefined}
        onStart={(template) => { void start(template); }}
      /> : null}
    </div>
    <p className="chat-voting-immediate__reason" title={reason} aria-live="polite">{reason}</p>
  </section>;
};

export default ChatVotingImmediateAction;
