import { useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import {
  ActionMenu,
  Badge,
  Button,
  ConfirmDialog,
  SwitchRow,
  notify,
} from "../../../dashboard/ui";
import { moduleQueryKey, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import type { ModulePanelProperties, RegisteredChannelPointsAction } from "../../contract";
import type {
  ChannelPointsRedemption,
  ChannelPointsReward,
  ChannelPointsRewardInput,
} from "../contracts";
import {
  createChannelPointsReward,
  deleteChannelPointsReward,
  loadChannelPointsModuleAvailability,
  loadChannelPointsRedemptions,
  loadChannelPointsState,
  reconcileChannelPoints,
  recreateChannelPointsReward,
  updateChannelPointsReward,
} from "./service";
import type { ChannelPointsHistoryPage, ChannelPointsModuleAvailability, ChannelPointsPanelState } from "./service";
import { channelPointsPanelTexts } from "./locale";
import RewardEditorDialog from "./RewardEditorDialog";
import "./panel.css";

type Language = "de" | "en";
type EditorState = { reward: ChannelPointsReward | null };

const EMPTY_STATE: ChannelPointsPanelState = {
  rewards: [],
  moduleEnabled: false,
  connection: { connected: false, scopes: [], missingScopes: [] },
};
const EMPTY_HISTORY: ChannelPointsHistoryPage = { items: [], cursor: null };

const errorCode = (error: unknown): string | null => error instanceof PanelApiError ? error.code : null;

const mutationError = (error: unknown, language: Language): string => {
  const labels = channelPointsPanelTexts[language];
  switch (errorCode(error)) {
    case "channel_points_not_affiliate": return labels.notAffiliate;
    case "channel_points_reward_limit": return labels.rewardLimit;
    case "channel_points_duplicate_title": return labels.duplicateTitle;
    case "channel_points_scope_missing": return labels.missingScopes(["channel:read:redemptions", "channel:manage:redemptions"]);
    case "channel_points_not_connected":
    case "channel_points_token_unavailable":
    case "channel_points_revoked":
    case "channel_points_refresh_failed": return labels.missingAuthorization;
    case "channel_points_management_denied": return labels.managementDenied;
    case "channel_points_operation_denied": return labels.operationDenied;
    default: return labels.requestFailed;
  }
};

const actionName = (reward: ChannelPointsReward, language: Language, actions: readonly RegisteredChannelPointsAction[]): string =>
  actions.find(({ moduleId, definition }) => moduleId === reward.actionModuleId && definition.id === reward.actionId)
    ?.definition.name[language]
  ?? channelPointsPanelTexts[language].actionUnavailable;

const rewardInputFromReward = (reward: ChannelPointsReward): ChannelPointsRewardInput => ({
  title: reward.title,
  prompt: reward.prompt,
  cost: reward.cost,
  backgroundColor: reward.backgroundColor,
  isUserInputRequired: reward.isUserInputRequired,
  globalCooldownSeconds: reward.globalCooldownSeconds,
  maxPerStream: reward.maxPerStream,
  maxPerUserPerStream: reward.maxPerUserPerStream,
  actionModuleId: reward.actionModuleId,
  actionId: reward.actionId,
  actionConfig: reward.actionConfig,
  mode: reward.mode,
  enabled: reward.enabled,
});

const formatTime = (value: string, language: Language): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
};

const rewardState = (
  reward: ChannelPointsReward,
  moduleEnabled: boolean,
  language: Language,
): { label: string; tone: "green" | "amber" | "neutral" | "red" } => {
  const labels = channelPointsPanelTexts[language];
  if (reward.twitchState === "creating") return { label: labels.statusCreating, tone: "amber" };
  if (reward.twitchState === "deleted_on_twitch") return { label: labels.statusDeleted, tone: "red" };
  if (!moduleEnabled) return { label: labels.statusDisabledByModule, tone: "neutral" };
  if (!reward.enabled) return { label: labels.statusDisabled, tone: "neutral" };
  return { label: labels.statusActive, tone: "green" };
};

const redemptionOutcome = (
  redemption: ChannelPointsRedemption,
  language: Language,
): { label: string; tone: "green" | "amber" | "neutral" | "red" } => {
  const labels = channelPointsPanelTexts[language];
  const reason = redemption.outcomeReason?.[language] ?? "";
  if (redemption.status === "fulfilled") return { label: labels.outcomeFulfilled, tone: "green" };
  if (redemption.status === "refunded") return {
    label: labels.outcomeRefunded(reason || labels.outcomeFailed), tone: "amber",
  };
  if (redemption.status === "orphaned") return {
    label: labels.outcomeOrphaned(reason || labels.outcomeFailed), tone: "red",
  };
  if (redemption.status === "failed_to_update") return { label: labels.outcomeFailed, tone: "red" };
  return { label: labels.outcomeOpen, tone: "neutral" };
};

function RewardRow({
  reward,
  moduleEnabled,
  actions,
  language,
  canManage,
  onEdit,
  onDelete,
  onRecreate,
  onToggle,
}: {
  reward: ChannelPointsReward;
  moduleEnabled: boolean;
  actions: readonly RegisteredChannelPointsAction[];
  language: Language;
  canManage: boolean;
  onEdit: (reward: ChannelPointsReward) => void;
  onDelete: (reward: ChannelPointsReward) => void;
  onRecreate: (reward: ChannelPointsReward) => void;
  onToggle: (reward: ChannelPointsReward, enabled: boolean) => void;
}): ReactElement {
  const labels = channelPointsPanelTexts[language];
  const status = rewardState(reward, moduleEnabled, language);
  const menuItems = [
    { label: labels.edit, onSelect: () => onEdit(reward) },
    { divider: true as const },
    { label: labels.delete, danger: true, onSelect: () => onDelete(reward) },
  ];
  return <li className="channel-points-reward-list__item">
    <article className="channel-points-reward-row" aria-label={reward.title}>
      <div className="channel-points-reward-row__main">
        <strong className="channel-points-reward-row__title" title={reward.title}>{reward.title}</strong>
        <span className="channel-points-reward-row__cost">{new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(reward.cost)} {labels.points}</span>
      </div>
      <div className="channel-points-reward-row__meta">
        <span className="channel-points-reward-row__action" title={actionName(reward, language, actions)}>{actionName(reward, language, actions)}</span>
        <span className="channel-points-reward-row__mode">{reward.mode === "auto" ? labels.modeAutomatic : labels.modeQueue}</span>
      </div>
      <Badge tone={status.tone}>{status.label}</Badge>
      {canManage ? <div className="channel-points-reward-row__controls">
        {reward.twitchState === "deleted_on_twitch"
          ? <Button size="compact" ariaLabel={labels.recreateReward(reward.title)} onClick={() => onRecreate(reward)}>{labels.recreateShort}</Button>
          : <SwitchRow
            label={labels.active}
            ariaLabel={labels.activeReward(reward.title)}
            checked={reward.enabled}
            disabled={reward.twitchState === "creating"}
            onChange={(enabled) => onToggle(reward, enabled)}
          />}
        <ActionMenu label={labels.moreActions(reward.title)} items={menuItems} />
      </div> : null}
    </article>
  </li>;
}

function RedemptionRow({ redemption, language }: { redemption: ChannelPointsRedemption; language: Language }): ReactElement {
  const labels = channelPointsPanelTexts[language];
  const outcome = redemptionOutcome(redemption, language);
  return <li className="channel-points-history__item">
    <article className="channel-points-history-row" aria-label={`${redemption.userName} · ${redemption.rewardTitle}`}>
      <time className="channel-points-history-row__time" dateTime={redemption.redeemedAt}>{formatTime(redemption.redeemedAt, language)}</time>
      <strong className="channel-points-history-row__viewer" title={redemption.userName}>{redemption.userName}</strong>
      <span className="channel-points-history-row__reward" title={redemption.rewardTitle}>{redemption.rewardTitle}</span>
      <span className="channel-points-history-row__input" title={redemption.userInput || undefined}>
        {redemption.userInput.length > 100 ? `${redemption.userInput.slice(0, 100)}…` : redemption.userInput || "—"}
      </span>
      <Badge tone={outcome.tone}>{outcome.label}</Badge>
      <span className="sr-only">{labels.viewer}: {redemption.userLogin}</span>
    </article>
  </li>;
}

export default function ChannelPointsPanel({
  channelId,
  language = "de",
  canManage = false,
  canOperate = false,
  channelPointsActions = [],
}: ModulePanelProperties): ReactElement {
  const activeLanguage: Language = language === "en" ? "en" : "de";
  const labels = channelPointsPanelTexts[activeLanguage];
  const queryClient = useDashboardQueryClient();
  const stateQuery = useModuleQuery(channelId, "channel_points", "data", (signal) => loadChannelPointsState(channelId, signal));
  const availabilityQuery = useModuleQuery(channelId, "channel_points", "providers", (signal) => loadChannelPointsModuleAvailability(channelId, signal));
  const [historyCursors, setHistoryCursors] = useState<(string | null)[]>([null]);
  const currentCursor = historyCursors.at(-1) ?? null;
  const historyPart = currentCursor === null ? "history:first" : `history:${currentCursor}`;
  const historyQuery = useModuleQuery(channelId, "channel_points", historyPart,
    (signal) => loadChannelPointsRedemptions(channelId, currentCursor, signal));
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirming, setConfirming] = useState<ChannelPointsReward | null>(null);
  const [pendingRewardId, setPendingRewardId] = useState<string | null>(null);
  const [reconcilePending, setReconcilePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const state = stateQuery.data ?? EMPTY_STATE;
  const history = historyQuery.data ?? EMPTY_HISTORY;
  const moduleAvailability: readonly ChannelPointsModuleAvailability[] = availabilityQuery.data ?? [];
  const stateQueryKey = moduleQueryKey(channelId, "channel_points", "data");
  const activeReward = editor?.reward ?? null;

  const updateStateCache = (current: unknown, saved: ChannelPointsReward): ChannelPointsPanelState => {
    const currentState = typeof current === "object" && current !== null
      ? current as ChannelPointsPanelState
      : EMPTY_STATE;
    const existing = currentState.rewards.some(({ id }) => id === saved.id);
    return {
      ...currentState,
      rewards: existing
        ? currentState.rewards.map((reward) => reward.id === saved.id ? saved : reward)
        : [saved, ...currentState.rewards],
    };
  };

  const saveReward = async (input: ChannelPointsRewardInput, rewardId: string | null): Promise<ChannelPointsReward> => {
    setPageNotice(null);
    const result = await runModuleQueryWrite(
      queryClient,
      channelId,
      "channel_points",
      "data",
      () => rewardId === null
        ? createChannelPointsReward(channelId, input)
        : updateChannelPointsReward(channelId, rewardId, input),
      {
        baselineRevision: null,
        updateCache: (current, saved) => updateStateCache(current, saved),
        relatedParts: [{ moduleId: "channel_points", part: historyPart }],
      },
    );
    setHistoryCursors([null]);
    notify({ tone: "success", message: labels.rewardSaved });
    return result;
  };

  const toggleReward = async (reward: ChannelPointsReward, enabled: boolean): Promise<void> => {
    if (!canManage || pendingRewardId !== null) return;
    setPendingRewardId(reward.id);
    setPageNotice(null);
    const previous = queryClient.getQueryData<ChannelPointsPanelState>(stateQueryKey) ?? state;
    queryClient.setQueryData<ChannelPointsPanelState>(stateQueryKey, {
      ...previous,
      rewards: previous.rewards.map((item) => item.id === reward.id ? { ...item, enabled } : item),
    });
    try {
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "channel_points",
        "data",
        () => updateChannelPointsReward(channelId, reward.id, { ...rewardInputFromReward(reward), enabled }),
        {
          baselineRevision: null,
          updateCache: (current, saved) => updateStateCache(current, saved),
          relatedParts: [{ moduleId: "channel_points", part: historyPart }],
        },
      );
    } catch (error) {
      queryClient.setQueryData(stateQueryKey, previous);
      const message = mutationError(error, activeLanguage);
      setPageNotice(message);
      notify({ tone: "error", message });
    } finally {
      setPendingRewardId(null);
    }
  };

  const deleteReward = async (): Promise<void> => {
    const target = confirming;
    if (target === null || deletePending) return;
    setDeletePending(true);
    setPageNotice(null);
    try {
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "channel_points",
        "data",
        async () => { await deleteChannelPointsReward(channelId, target.id); return target.id; },
        {
          baselineRevision: null,
          updateCache: (current, id) => {
            const currentState = typeof current === "object" && current !== null
              ? current as ChannelPointsPanelState
              : EMPTY_STATE;
            return { ...currentState, rewards: currentState.rewards.filter((item) => item.id !== id) };
          },
          relatedParts: [{ moduleId: "channel_points", part: historyPart }],
        },
      );
      setConfirming(null);
      setHistoryCursors([null]);
      notify({ tone: "success", message: labels.deleteSuccess });
    } catch (error) {
      const message = mutationError(error, activeLanguage);
      setPageNotice(message);
      notify({ tone: "error", message });
      setConfirming(null);
    } finally {
      setDeletePending(false);
    }
  };

  const recreateReward = async (reward: ChannelPointsReward): Promise<void> => {
    if (!canManage || pendingRewardId !== null) return;
    setPendingRewardId(reward.id);
    setPageNotice(null);
    try {
      const recreated = await runModuleQueryWrite(
        queryClient,
        channelId,
        "channel_points",
        "data",
        () => recreateChannelPointsReward(channelId, reward.id),
        {
          baselineRevision: null,
          updateCache: (current, result) => updateStateCache(current, result),
          relatedParts: [{ moduleId: "channel_points", part: historyPart }],
        },
      );
      setHistoryCursors([null]);
      notify({ tone: "success", message: labels.rewardRecreated });
      setPageNotice(null);
      void recreated;
    } catch (error) {
      const message = mutationError(error, activeLanguage);
      setPageNotice(message);
      notify({ tone: "error", message });
    } finally {
      setPendingRewardId(null);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!canOperate || reconcilePending) return;
    setReconcilePending(true);
    setPageNotice(null);
    try {
      const result = await reconcileChannelPoints(channelId);
      if (!result.ok) {
        const message = labels.reconcileFailed;
        setPageNotice(message);
        notify({ tone: "error", message });
      } else {
        notify({ tone: "success", message: labels.reconcileSuccess });
      }
      await Promise.all([stateQuery.refetch(), historyQuery.refetch()]);
    } catch (error) {
      const message = mutationError(error, activeLanguage);
      setPageNotice(message);
      notify({ tone: "error", message });
    } finally {
      setReconcilePending(false);
    }
  };

  const readiness = (): { unavailable: boolean; message: string } => {
    if (!stateQuery.isFetched) return { unavailable: true, message: labels.loading };
    if (!state.connection.connected) return { unavailable: true, message: labels.missingAuthorization };
    if (state.connection.missingScopes.length > 0) return {
      unavailable: true,
      message: labels.missingScopes(state.connection.missingScopes),
    };
    return { unavailable: false, message: labels.ready };
  };

  const readinessStatus = readiness();
  const fixedStatus = pageNotice ?? (stateQuery.isError ? labels.loadFailed : readinessStatus.message);
  const fixedStatusUnavailable = pageNotice !== null || stateQuery.isError || readinessStatus.unavailable;

  return <section className="module-stack channel-points-panel" aria-label={labels.page}>
    <div className={`channel-points-panel__readiness${fixedStatusUnavailable ? " is-unavailable" : " is-ready"}`}
      role={fixedStatusUnavailable ? "alert" : "status"} aria-live="polite" aria-atomic="true">
      <Badge tone={fixedStatusUnavailable ? "amber" : "green"}>
        {fixedStatusUnavailable ? labels.unavailable : labels.available}
      </Badge>
      <span title={fixedStatus}>{fixedStatus || "\u00a0"}</span>
      {stateQuery.isError ? <Button size="compact" icon="reload" onClick={() => { void stateQuery.refetch(); }}>{labels.retry}</Button> : null}
    </div>

    <section className="channel-points-section" aria-labelledby="channel-points-rewards-heading">
      <div className="channel-points-section__heading">
        <h2 id="channel-points-rewards-heading">{labels.rewards}</h2>
        <div className="channel-points-panel__toolbar">
          {canManage ? <Button variant="primary" icon="add" onClick={() => setEditor({ reward: null })}>{labels.newReward}</Button> : null}
          {canOperate ? <Button
            variant="neutral"
            icon="reload"
            disabled={reconcilePending || stateQuery.isPending}
            onClick={() => { void reconcile(); }}
          >{reconcilePending ? labels.refreshing : labels.refreshFromTwitch}</Button> : null}
        </div>
      </div>
      <div className="channel-points-panel__load-status" role="status" aria-live="polite">
        {stateQuery.isPending ? labels.loading : stateQuery.isError ? labels.loadFailed : "\u00a0"}
      </div>
      {stateQuery.isPending
        ? <div className="channel-points-reward-list channel-points-reward-list--empty" aria-hidden="true" />
        : state.rewards.length === 0
          ? <p className="channel-points-panel__empty">{labels.rewardsEmpty}</p>
          : <ul className="channel-points-reward-list">
            {state.rewards.map((reward) => <RewardRow
              key={reward.id}
              reward={reward}
              moduleEnabled={state.moduleEnabled}
              actions={channelPointsActions}
              language={activeLanguage}
              canManage={canManage}
              onEdit={(selected) => setEditor({ reward: selected })}
              onDelete={setConfirming}
              onRecreate={(selected) => { void recreateReward(selected); }}
              onToggle={(selected, enabled) => { void toggleReward(selected, enabled); }}
            />)}
          </ul>}
    </section>

    <section className="channel-points-section channel-points-history" aria-labelledby="channel-points-history-heading" aria-label={labels.history}>
      <div className="channel-points-section__heading">
        <h2 id="channel-points-history-heading">{labels.history}</h2>
        <div className="channel-points-history__pagination">
          {historyCursors.length > 1 ? <Button
            size="compact"
            icon="chevron-left"
            iconOnly
            ariaLabel={labels.previousPage}
            disabled={historyQuery.isFetching}
            onClick={() => setHistoryCursors((current) => current.slice(0, -1))}
          /> : null}
          <span>{labels.pageCount(historyCursors.length)}</span>
          {history.cursor !== null ? <Button
            size="compact"
            icon="chevron-right"
            iconOnly
            ariaLabel={labels.nextPage}
            disabled={historyQuery.isFetching}
            onClick={() => setHistoryCursors((current) => [...current, history.cursor])}
          /> : null}
        </div>
      </div>
      <div className="channel-points-panel__load-status" role="status" aria-live="polite">
        {historyQuery.isPending ? labels.loading : historyQuery.isError ? labels.loadFailed : "\u00a0"}
      </div>
      {history.items.length === 0
        ? <p className="channel-points-panel__empty">{labels.historyEmpty}</p>
        : <ul className="channel-points-history__list">
          {history.items.map((redemption) => <RedemptionRow key={redemption.redemptionId} redemption={redemption} language={activeLanguage} />)}
        </ul>}
    </section>

    {editor === null ? null : <RewardEditorDialog
      key={editor.reward?.id ?? "create"}
      channelId={channelId}
      language={activeLanguage}
      reward={activeReward}
      channelPointsActions={channelPointsActions}
      moduleAvailability={moduleAvailability}
      onClose={() => setEditor(null)}
      onSave={saveReward}
      onReadinessError={setPageNotice}
    />}

    <ConfirmDialog
      opened={confirming !== null}
      title={labels.deleteTitle(confirming?.title ?? "")}
      description={labels.deleteDescription(confirming?.title ?? "")}
      confirmLabel={labels.confirmDelete(confirming?.title ?? "")}
      cancelLabel={labels.cancel}
      danger
      pending={deletePending}
      onCancel={() => setConfirming(null)}
      onConfirm={() => { void deleteReward(); }}
    />
  </section>;
}
