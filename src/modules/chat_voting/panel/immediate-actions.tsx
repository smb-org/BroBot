import { useCallback, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Led, LoadState, notify } from "../../../dashboard/ui";
import { dashboardTexts } from "../../../dashboard/locale";
import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useManualQueryFailure, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import type { ModuleImmediateActionProperties } from "../../contract";
import { chatVoteDurationText, chatVotingSavedPanelTexts } from "./locale-saved";
import { ChatVoteTemplateList } from "./template-list";
import { closeChatVoting, laterUsageTime, loadChatVotingState, loadChatVoteTemplates, mergeChatVoteTemplateLists, startChatVoting, type ChatVotingPanelState, type ChatVoteTemplateListState } from "./service";
import { timeText } from "./date-range";

const isAbortedRequest = (failure: unknown): boolean => typeof failure === "object" && failure !== null &&
  "name" in failure && (failure.name === "AbortError" || failure.name === "CancelledError");

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
  const { clear: clearTemplateFailure, failedAt: templateFailedAt, markFailed: markTemplateFailure } = useManualQueryFailure();
  const { clear: clearCurrentFailure, failedAt: currentFailedAt, markFailed: markCurrentFailure } = useManualQueryFailure();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const vote = state?.vote ?? null;
  const running = vote?.status === "open";
  const templateError = templatesQuery.isError || (templateFailedAt !== null && templateFailedAt === templatesQuery.dataUpdatedAt);
  const currentLoadError = stateQuery.isError || (currentFailedAt !== null && currentFailedAt === stateQuery.dataUpdatedAt);
  const lockReason = availabilityReason ?? (currentLoadError
    ? labels.liveLoadError
    : state === null ? labels.loading : running ? labels.runningLocked : state.hasOpenBallot ? labels.votekickLocked : null);

  const refreshTemplates = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVoteTemplateListState>(queryClient, channelId, "chat_voting", "templates");
      clearTemplateFailure();
    } catch (failure: unknown) {
      if (isAbortedRequest(failure)) return;
      markTemplateFailure(queryClient.getQueryState(moduleQueryKey(channelId, "chat_voting", "templates"))?.dataUpdatedAt ?? templatesQuery.dataUpdatedAt);
    }
  }, [channelId, clearTemplateFailure, markTemplateFailure, queryClient, templatesQuery.dataUpdatedAt]);

  const refreshVote = useCallback(async (): Promise<void> => {
    try {
      await refetchModuleQueryData<ChatVotingPanelState>(queryClient, channelId, "chat_voting", "panel");
      clearCurrentFailure();
    } catch (failure: unknown) {
      if (isAbortedRequest(failure)) return;
      // Keep the last known live state visible while the template list loads independently.
      markCurrentFailure(queryClient.getQueryState(moduleQueryKey(channelId, "chat_voting", "panel"))?.dataUpdatedAt ?? stateQuery.dataUpdatedAt);
    }
  }, [channelId, clearCurrentFailure, markCurrentFailure, queryClient, stateQuery.dataUpdatedAt]);

  const start = async (template: NonNullable<ChatVoteTemplateListState>["templates"][number]): Promise<void> => {
    if (lockReason !== null || pendingId !== null) return;
    setPendingId(template.id);
    try {
      await runModuleQueryWrite(queryClient, channelId, "chat_voting", "templates",
        () => startChatVoting(channelId, { templateId: template.id }), {
          baselineRevision: template.revision,
          updateCache: (current, started) => {
            if (current === undefined) return current;
            const previous = current as ChatVoteTemplateListState;
            return {
              ...previous,
              templates: previous.templates.map((entry) => entry.id === template.id
                ? { ...entry, lastUsedAt: laterUsageTime(entry.lastUsedAt, started.openedAt) }
                : entry),
            };
          },
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
    ? ""
    : templates === null
      ? labels.loading
      : templates.templates.length === 0
        ? labels.noTemplatesLocked
        : lockReason ?? "";
  const liveStatus = state === null ? labels.loading : running ? labels.running : labels.idle;
  const liveQueryError = {
    title: dashboardTexts().errors.dataLoadFailed,
    message: labels.liveLoadError,
    onRetry: () => { void refreshVote(); },
  };
  const templateQueryError = {
    title: dashboardTexts().errors.dataLoadFailed,
    message: labels.templatesError,
    onRetry: () => { void refreshTemplates(); },
  };

  return <section className="stream-manager-action chat-voting-immediate" aria-label={labels.title}>
    <header className="chat-voting-immediate__header">
      <h3>{labels.title}</h3>
      <Led status={running ? "green" : "off"} word={liveStatus} />
      {running ? <Button danger size="compact" disabled={ending} onClick={() => { void end(); }}>{labels.end}</Button> : <span aria-hidden="true" />}
    </header>
    <LoadState
      variant="status-row"
      status={currentLoadError ? "error" : state === null ? "loading" : "success"}
      loading={<span className="chat-voting-immediate__question">{labels.loading}</span>}
      empty={null}
      error={<span />}
      queryError={liveQueryError}
      className="chat-voting-immediate__live-state"
    >
      <div className="chat-voting-immediate__status">
        <span className="chat-voting-immediate__question" title={vote?.title ?? ""}>{vote?.title || labels.idle}</span>
        {running ? <span className="chat-voting-immediate__ending mono">{vote.requestedDurationSeconds === null ? labels.open : timeText(vote.closesAt, language)}</span> : null}
      </div>
    </LoadState>
    <div className="chat-voting-immediate__list" aria-label={labels.saved}>
      <LoadState
        variant="compact-64"
        status={templateError ? "error" : templates === null ? "loading" : "success"}
        loading={<p className="chat-voting-immediate__loading">{labels.loading}</p>}
        empty={null}
        error={<span />}
        queryError={templateQueryError}
      >
        {templates === null ? null : <ChatVoteTemplateList
          templates={templates.templates}
          vote={vote}
          startsLockedReason={lockReason}
          canOperate
          pendingId={pendingId}
          labels={labels}
          durationText={(seconds) => chatVoteDurationText(seconds, language)}
          onSelect={() => undefined}
          onStart={(template) => { void start(template); }}
        />}
      </LoadState>
    </div>
    <p className="chat-voting-immediate__reason" title={reason} aria-live="polite">{reason}</p>
  </section>;
};

export default ChatVotingImmediateAction;
