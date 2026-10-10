import { useCallback, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Led, notify } from "../../../dashboard/ui";
import { moduleQueryKey, refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import type { ModuleImmediateActionProperties } from "../../contract";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateList } from "./template-list";
import { closeChatVoting, loadChatVotingState, loadChatVoteTemplates, mergeChatVoteTemplateLists, startChatVoting, type ChatVotingPanelState, type ChatVoteTemplateListState } from "./service";
import { timeText } from "./date-range";

const ChatVotingImmediateAction = (properties: ModuleImmediateActionProperties): ReactElement =>
  <ChatVotingImmediateActionForChannel key={properties.channelId} {...properties} />;

const ChatVotingImmediateActionForChannel = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";
  const labels = chatVotingSavedPanelTexts(language);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const queryClient = useDashboardQueryClient();
  const fallbackRefetchInterval = realtimeStatus === "connected" ? false : 2_000;
  const stateQuery = useModuleQuery(channelId, "chat_voting", "panel", (signal) => loadChatVotingState(channelId, signal), {
    refetchInterval: fallbackRefetchInterval,
  });
  const templatesQuery = useModuleQuery(channelId, "chat_voting", "templates", async (signal) => {
    const latest = await loadChatVoteTemplates(channelId, signal);
    return mergeChatVoteTemplateLists(
      queryClient.getQueryData<ChatVoteTemplateListState>(moduleQueryKey(channelId, "chat_voting", "templates")) ?? null,
      latest,
    );
  }, {
    refetchInterval: fallbackRefetchInterval,
  });
  const state = stateQuery.data ?? null;
  const templates = templatesQuery.data ?? null;
  const [templateFailureData, setTemplateFailureData] = useState<ChatVoteTemplateListState | null | "none">("none");
  const [currentFailureData, setCurrentFailureData] = useState<ChatVotingPanelState | null | "none">("none");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const vote = state?.vote ?? null;
  const running = vote?.status === "open";
  const templateError = templatesQuery.isError || (templateFailureData !== "none" && templateFailureData === templates);
  const currentLoadError = stateQuery.isError || (currentFailureData !== "none" && currentFailureData === state);
  const lockReason = availabilityReason ?? (currentLoadError
    ? labels.liveLoadError
    : state === null ? labels.loading : running ? labels.runningLocked : state.hasOpenBallot ? labels.votekickLocked : null);

  const refreshTemplates = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVoteTemplateListState>(queryClient, channelId, "chat_voting", "templates");
      setTemplateFailureData("none");
    } catch {
      setTemplateFailureData(templates);
    }
  }, [channelId, queryClient, templates]);

  const refreshVote = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVotingPanelState>(queryClient, channelId, "chat_voting", "panel");
      setCurrentFailureData("none");
    } catch {
      // Keep the last known live state visible while the template list loads independently.
      setCurrentFailureData(state);
    }
  }, [channelId, queryClient, state]);

  const start = async (template: NonNullable<ChatVoteTemplateListState>["templates"][number]): Promise<void> => {
    if (lockReason !== null || pendingId !== null) return;
    setPendingId(template.id);
    try {
      const started = await startChatVoting(channelId, { templateId: template.id });
      queryClient.setQueryData<ChatVoteTemplateListState>(
        moduleQueryKey(channelId, "chat_voting", "templates"),
        (current) => current === undefined ? current : {
          ...current,
          templates: current.templates.map((entry) => entry.id === template.id
            ? { ...entry, lastUsedAt: started.openedAt }
            : entry),
        },
      );
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
  const liveStatus = currentLoadError ? labels.liveLoadError : state === null ? labels.loading : running ? labels.running : labels.idle;

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
