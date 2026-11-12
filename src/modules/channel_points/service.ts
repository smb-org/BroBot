import type { AuthorizeModuleMutation, ModuleAlarmContext, ModuleAlarmDefinition, ModuleEvent, ModuleExecutionContext, ModuleMutationActor, ModuleResult } from "../contract";
import type { ChannelPointsActionOutcome } from "./domain/redemption";
import {
  channelPointsActionTransition, eventSubRedemptionStatus, helixRedemptionStatus,
  redemptionFromEventSub, redemptionFromHelix, rewardSnapshotFromEventSub,
} from "./domain/redemption";
import type {
  ChannelPointsRedemption,
  ChannelPointsRedemptionStatus,
  ChannelPointsReward,
  ChannelPointsRewardInput,
  ChannelPointsHelixReason,
  HelixRedemption,
  NormalizedTwitchRedemptionStatus,
  TwitchRedemptionStatus,
} from "./contracts";
import { CHANNEL_POINTS_MAX_REWARDS, channelPointsRewardInputSchema } from "./contracts";
import { createChannelPointsRepository } from "./repository";

const loadHelix = () => import("../../worker/twitch/channel-points");
const loadActionContext = () => import("../../worker/module-action-context");
const RECONCILE_INTERVAL_MS = 15_000;
const REDEMPTION_CLAIM_LEASE_MS = 2 * 60 * 1_000;
const CREATING_REWARD_MAX_AGE_MS = 10 * 60 * 1_000;
export const CHANNEL_POINTS_LIFECYCLE_HANDLER = "serialized-lifecycle";
export const CHANNEL_POINTS_LIFECYCLE_ALARM = "channel-points";
const redemptionStatuses: readonly ChannelPointsRedemptionStatus[] = [
  "received", "running", "queued", "pending", "fulfilled", "refunded", "failed_to_update",
];
const noResult: ModuleResult = { actions: [], diagnostics: [] };
const missingAction: { de: string; en: string } = {
  de: "Die Belohnungsaktion ist nicht mehr verfügbar.",
  en: "The reward action is no longer available.",
};
const providerDisabled: { de: string; en: string } = {
  de: "Das Modul für diese Belohnungsaktion ist deaktiviert.",
  en: "The module providing this reward action is disabled.",
};
const deletedRewardReason = {
  de: "Diese Belohnung wurde auf Twitch gelöscht. Twitch erstattet nicht erfüllte Einlösungen automatisch.",
  en: "This reward was deleted on Twitch. Twitch automatically refunds its unfulfilled redemptions.",
};
const operatorRefundReason = {
  de: "Von einem Bediener erstattet.",
  en: "Refunded by operator.",
};
const missingTwitchRedemptionReason = {
  de: "Diese Einlösung wurde auf Twitch nicht gefunden.",
  en: "This redemption could not be found on Twitch.",
};
export type ChannelPointsMutationAuthorization = () => Promise<boolean>;
interface ChannelPointsReconcileFailure {
  rewardId: string;
  reason: ChannelPointsHelixReason;
}
export type ChannelPointsReconcileResult = "success" | ChannelPointsHelixReason |
  { failedRewards: readonly ChannelPointsReconcileFailure[] } | { error: "channel_points_module_disabled" };

const expiredBeforeFor = (now: string): string => {
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp) ? new Date(timestamp - REDEMPTION_CLAIM_LEASE_MS).toISOString() : now;
};

const confirmTwitchRewardDeleted = async (
  environment: Env,
  channelId: string,
  twitchRewardId: string,
  now: string,
  eventAt?: string,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const currentReward = await repository.getRewardByTwitchId(channelId, twitchRewardId);
  if (currentReward !== null && !await repository.markRewardDeleted(channelId, twitchRewardId, now, eventAt)) return;
  await repository.orphanOpenRedemptions(channelId, twitchRewardId, deletedRewardReason, now);
};

const sendStatus = async (
  environment: Env,
  channelId: string,
  twitchRewardId: string,
  redemptionId: string,
  status: TwitchRedemptionStatus,
  authorize: ChannelPointsMutationAuthorization,
): Promise<"success" | ChannelPointsHelixReason> => {
  const result = await (await loadHelix()).updateRedemptionStatus(
    environment, channelId, twitchRewardId, [redemptionId], status, authorize,
  );
  if (!result.ok && result.reason === "not_found") {
    await confirmTwitchRewardDeleted(environment, channelId, twitchRewardId, new Date().toISOString());
  }
  return result.ok ? "success" : result.reason;
};

const applyOutcome = async (
  environment: Env,
  channelId: string,
  twitchRewardId: string,
  redemptionId: string,
  outcome: ChannelPointsActionOutcome,
  now: string,
  authorize: ChannelPointsMutationAuthorization,
): Promise<{ ok: true; status: "pending" | "fulfilled" | "refunded" } | { ok: false; reason: ChannelPointsHelixReason }> => {
  const repository = createChannelPointsRepository(environment.DB);
  const transition = channelPointsActionTransition("auto", outcome);
  const recorded = await repository.updateRedemption(channelId, redemptionId, {
    status: transition.status,
    pendingTwitchStatus: transition.pendingTwitchStatus ?? null,
    outcomeReason: transition.outcomeReason ?? null,
    claimedAt: transition.status === "pending" || transition.status === "running" ? now : null,
  }, ["running"], now);
  if (!recorded) return { ok: false, reason: "precondition_failed" };
  if (transition.pendingTwitchStatus === undefined) return { ok: true, status: "pending" };
  const patched = await sendStatus(environment, channelId, twitchRewardId, redemptionId, transition.pendingTwitchStatus, authorize);
  const finishedAt = new Date().toISOString();
  if (patched === "success") {
    await repository.updateRedemption(channelId, redemptionId, {
      status: transition.pendingTwitchStatus === "FULFILLED" ? "fulfilled" : "refunded",
      pendingTwitchStatus: null,
      outcomeReason: transition.outcomeReason ?? null,
      claimedAt: null,
    }, ["running"], finishedAt);
    return { ok: true, status: transition.pendingTwitchStatus === "FULFILLED" ? "fulfilled" : "refunded" };
  } else {
    await repository.updateRedemption(channelId, redemptionId, {
      status: "failed_to_update",
      pendingTwitchStatus: transition.pendingTwitchStatus,
      outcomeReason: transition.outcomeReason ?? null,
      claimedAt: finishedAt,
    }, ["running"], finishedAt);
    return { ok: false, reason: patched };
  }
};

const actionOutcome = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  redemption: NonNullable<ReturnType<typeof redemptionFromEventSub>>,
  context: ModuleExecutionContext | null,
): Promise<ChannelPointsActionOutcome> => {
  const { MODULES } = await import("../registry");
  const provider = MODULES.find((module) => module.id === reward.actionModuleId);
  const action = provider?.channelPointsActions?.find((item) => item.id === reward.actionId);
  if (provider === undefined || action === undefined) return { refund: missingAction };
  const enabled = await environment.DB.prepare(
    "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = ?",
  ).bind(channelId, provider.id).first<{ enabled: number }>();
  if (enabled?.enabled !== 1) return { refund: providerDisabled };
  const parsedConfig = action.configSchema.safeParse(reward.actionConfig);
  if (!parsedConfig.success) return { refund: missingAction };
  const actionContext = context === null
    ? (await loadActionContext()).createModuleActionExecutionContext(environment, channelId, provider.id)
    : provider.id === "channel_points" ? context : context.forModule?.(provider.id);
  if (actionContext === undefined) return { refund: missingAction };
  try {
    return await action.execute(actionContext, {
      redemption,
      config: parsedConfig.data,
      operationId: redemption.id,
    });
  } catch {
    // A side effect may have reached Twitch before the handler failed; leave it open for idempotent retry.
    return "pending";
  }
};

const persistFromAction = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  redemption: NonNullable<ReturnType<typeof redemptionFromEventSub>>,
  context: ModuleExecutionContext | null,
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const now = new Date().toISOString();
  const inserted = await repository.latchRedemption(channelId, {
    ...redemption,
    rewardId: reward.id,
    twitchRewardId: redemption.rewardId,
    ...(reward.mode === "queue" ? { initialStatus: "queued" as const } : {}),
  }, now);
  if (!inserted || reward.mode === "queue") return;
  if (!await repository.claimRedemption(channelId, redemption.id, ["received"], expiredBeforeFor(now), now)) return;
  const claimed = await repository.getRedemption(channelId, redemption.id);
  if (claimed === null || claimed.status !== "running") return;
  await runClaimedAction(environment, channelId, reward, claimed, context, authorize);
};

const processNewRedemption = async (
  environment: Env,
  channelId: string,
  redemption: NonNullable<ReturnType<typeof redemptionFromEventSub>>,
  context: ModuleExecutionContext | null,
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const reward = await repository.getRewardByTwitchId(channelId, redemption.rewardId);
  if (reward === null) return;
  if (reward.twitchState === "deleted_on_twitch") {
    await repository.latchRedemption(channelId, {
      ...redemption,
      rewardId: reward.id,
      twitchRewardId: redemption.rewardId,
      initialStatus: "orphaned",
      initialOutcomeReason: deletedRewardReason,
    }, new Date().toISOString());
    return;
  }
  if (reward.twitchState !== "active") return;
  await persistFromAction(environment, channelId, reward, redemption, context, authorize);
};

const persistTwitchTerminalStatus = async (
  environment: Env,
  channelId: string,
  redemption: NonNullable<ReturnType<typeof redemptionFromEventSub>>,
  status: NormalizedTwitchRedemptionStatus | null,
  now: string,
): Promise<void> => {
  if (status !== "fulfilled" && status !== "canceled") return;
  const repository = createChannelPointsRepository(environment.DB);
  const saved = await repository.getRedemption(channelId, redemption.id);
  if (saved === null) {
    const reward = await repository.getRewardByTwitchId(channelId, redemption.rewardId);
    if (reward === null) return;
    const inserted = await repository.latchRedemption(channelId, {
      ...redemption,
      rewardId: reward.id,
      twitchRewardId: redemption.rewardId,
      initialStatus: status === "fulfilled" ? "fulfilled" : "refunded",
    }, now);
    if (inserted) return;
  }
  const current = saved ?? await repository.getRedemption(channelId, redemption.id);
  if (current === null) return;
  const reportedStatus = status;
  const expectedStatus: NormalizedTwitchRedemptionStatus | null = current.status === "fulfilled" ? "fulfilled"
    : current.status === "refunded" ? "canceled"
      : current.pendingTwitchStatus === "FULFILLED" ? "fulfilled"
        : current.pendingTwitchStatus === "CANCELED" ? "canceled" : null;
  const mismatch = expectedStatus !== null && expectedStatus !== reportedStatus;
  const mismatchReason = mismatch ? {
    de: `Twitch hat ${reportedStatus === "fulfilled" ? "erledigt" : "erstattet"} gemeldet, obwohl BroBot ${expectedStatus === "fulfilled" ? "Erledigung" : "Erstattung"} gespeichert hatte.`,
    en: `Twitch reported ${reportedStatus === "fulfilled" ? "fulfilled" : "refunded"} while BroBot had recorded ${expectedStatus === "fulfilled" ? "fulfilled" : "refunded"}.`,
  } : null;
  const outcomeReason = mismatchReason === null ? current.outcomeReason : {
    de: [current.outcomeReason?.de, mismatchReason.de].filter(Boolean).join(" "),
    en: [current.outcomeReason?.en, mismatchReason.en].filter(Boolean).join(" "),
  };
  await repository.updateRedemption(channelId, redemption.id, {
    status: status === "fulfilled" ? "fulfilled" : "refunded",
    pendingTwitchStatus: null,
    outcomeReason,
    claimedAt: null,
  }, redemptionStatuses, now);
};

const processChannelPointsEventInLane = async (
  event: ModuleEvent,
  environment: Env,
  context: ModuleExecutionContext | null,
): Promise<ModuleResult> => {
  const repository = createChannelPointsRepository(environment.DB);
  const now = event.eventSubTimestamp ?? event.receivedAt;
  if (event.subscriptionType === "channel.channel_points_custom_reward_redemption.add") {
    const redemption = redemptionFromEventSub(event.payload);
    if (redemption !== null) {
      await processNewRedemption(environment, event.channelId, redemption, context, () => Promise.resolve(true));
    }
  } else if (event.subscriptionType === "channel.channel_points_custom_reward_redemption.update") {
    const redemption = redemptionFromEventSub(event.payload);
    if (redemption !== null) await persistTwitchTerminalStatus(
      environment, event.channelId, redemption, eventSubRedemptionStatus(event.payload["status"]), now,
    );
  } else if (event.subscriptionType === "channel.channel_points_custom_reward.update") {
    const reward = rewardSnapshotFromEventSub(event.payload);
    if (reward !== null && await repository.getRewardByTwitchId(event.channelId, reward.twitchRewardId) !== null) {
      await repository.adoptTwitchReward(event.channelId, {
        id: reward.twitchRewardId, title: reward.title, prompt: reward.prompt, cost: reward.cost,
        backgroundColor: reward.backgroundColor, isUserInputRequired: reward.isUserInputRequired,
        globalCooldownSeconds: reward.globalCooldownSeconds, maxPerStream: reward.maxPerStream,
        maxPerUserPerStream: reward.maxPerUserPerStream, isEnabled: reward.enabled,
      }, now, now);
    }
  } else if (event.subscriptionType === "channel.channel_points_custom_reward.remove") {
    const twitchRewardId = typeof event.payload["id"] === "string" ? event.payload["id"] : "";
    if (twitchRewardId !== "") await confirmTwitchRewardDeleted(environment, event.channelId, twitchRewardId, now, now);
  }
  return noResult;
};

export const processChannelPointsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (context.environment === undefined) return noResult;
  if (context.runModuleAlarm !== undefined) {
    return await context.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "event",
      event,
    }) as ModuleResult;
  }
  return await processChannelPointsEventInLane(event, context.environment, context);
};

const redemptionRecord = (item: HelixRedemption) => redemptionFromHelix(item);

const runClaimedAction = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  row: ChannelPointsRedemption,
  context: ModuleExecutionContext | null,
  authorize: ChannelPointsMutationAuthorization,
): Promise<Awaited<ReturnType<typeof applyOutcome>>> => {
  const redemption = {
    id: row.redemptionId, rewardId: row.twitchRewardId, rewardTitle: row.rewardTitle, userId: row.userId,
    userLogin: row.userLogin, userName: row.userName, userInput: row.userInput, redeemedAt: row.redeemedAt,
  };
  const outcome = await actionOutcome(environment, channelId, reward, redemption, context);
  return await applyOutcome(environment, channelId, row.twitchRewardId, row.redemptionId, outcome, new Date().toISOString(), authorize);
};

const sendPendingTwitchPatch = async (
  environment: Env,
  channelId: string,
  row: ChannelPointsRedemption,
  expectedStatus: "running" | "failed_to_update",
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const pendingStatus = row.pendingTwitchStatus;
  if (pendingStatus === null) return;
  const patched = await sendStatus(environment, channelId, row.twitchRewardId, row.redemptionId, pendingStatus, authorize);
  const repository = createChannelPointsRepository(environment.DB);
  const finishedAt = new Date().toISOString();
  if (patched === "success") {
    await repository.updateRedemption(channelId, row.redemptionId, {
      status: pendingStatus === "FULFILLED" ? "fulfilled" : "refunded",
      pendingTwitchStatus: null,
      outcomeReason: row.outcomeReason,
      claimedAt: null,
    }, [expectedStatus], finishedAt);
    return;
  }
  await repository.updateRedemption(channelId, row.redemptionId, {
    status: "failed_to_update",
    pendingTwitchStatus: pendingStatus,
    outcomeReason: row.outcomeReason,
    claimedAt: finishedAt,
  }, [expectedStatus], finishedAt);
};

const retryExisting = async (
  environment: Env,
  channelId: string,
  row: ChannelPointsRedemption,
  reward: ChannelPointsReward,
  context: ModuleExecutionContext | null,
  authorize: ChannelPointsMutationAuthorization,
  now: string,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const expiredBefore = expiredBeforeFor(now);
  if (row.status === "failed_to_update") {
    if (row.pendingTwitchStatus === null || !await repository.claimFailedPatch(channelId, row.redemptionId, expiredBefore, now)) return;
    const claimed = await repository.getRedemption(channelId, row.redemptionId);
    if (claimed?.status === "failed_to_update") {
      await sendPendingTwitchPatch(environment, channelId, claimed, "failed_to_update", authorize);
    }
    return;
  }
  let claimed: boolean;
  if (row.status === "running") {
    claimed = await repository.reclaimRunningRedemption(channelId, row.redemptionId, expiredBefore, now);
  } else if (row.status === "received" || row.status === "pending") {
    claimed = await repository.claimRedemption(channelId, row.redemptionId, [row.status], expiredBefore, now);
  } else {
    return;
  }
  if (!claimed) return;
  const current = await repository.getRedemption(channelId, row.redemptionId);
  if (current === null || current.status !== "running") return;
  if (current.pendingTwitchStatus !== null) {
    await sendPendingTwitchPatch(environment, channelId, current, "running", authorize);
    return;
  }
  await runClaimedAction(environment, channelId, reward, current, context, authorize);
};

export const reconcileChannelPoints = async (
  environment: Env,
  channelId: string,
  now: string,
  options: { force?: boolean; authorize?: ChannelPointsMutationAuthorization; context?: ModuleExecutionContext | null } = {},
): Promise<ChannelPointsReconcileResult> => {
  const repository = createChannelPointsRepository(environment.DB);
  const previous = await repository.lastReconciledAt(channelId);
  const last = previous === null ? NaN : Date.parse(previous);
  const current = Date.parse(now);
  if (!options.force && Number.isFinite(last) && Number.isFinite(current) && current - last < RECONCILE_INTERVAL_MS) return "success";
  const authorize = options.authorize ?? (() => Promise.resolve(true));
  const failures = new Map<string, ChannelPointsHelixReason>();
  const fail = (rewardId: string, reason: ChannelPointsHelixReason): void => {
    if (!failures.has(rewardId)) failures.set(rewardId, reason);
  };
  let rewards = await repository.listRewards(channelId);

  // Step 1: refresh Twitch-owned reward state before reconciling redemptions.
  let manageableIds: Set<string> | null = null;
  try {
    const result = await (await loadHelix()).getManageableRewards(environment, channelId, authorize);
    if (!result.ok) {
      for (const reward of rewards) if (reward.twitchState === "active") fail(reward.twitchRewardId, result.reason);
    } else {
      manageableIds = new Set(result.data.map(({ id }) => id));
      const manageableById = new Map(result.data.map((reward) => [reward.id, reward]));
      const claimedCreatingRemoteIds = new Set<string>();
      const linkedRemoteIds = new Set(rewards
        .filter(({ twitchState }) => twitchState !== "creating")
        .map(({ twitchRewardId }) => twitchRewardId));
      const reconcileTimestamp = Date.parse(now);
      for (const reward of rewards.filter(({ twitchState }) => twitchState === "creating")) {
        const remote = result.data.find((candidate) => candidate.title === reward.title &&
          !linkedRemoteIds.has(candidate.id) && !claimedCreatingRemoteIds.has(candidate.id));
        try {
          if (remote !== undefined) {
            claimedCreatingRemoteIds.add(remote.id);
            await repository.adoptCreatingReward(channelId, reward.id, {
              twitchRewardId: remote.id, title: remote.title, prompt: remote.prompt, cost: remote.cost,
              backgroundColor: remote.background_color, isUserInputRequired: remote.is_user_input_required,
              globalCooldownSeconds: remote.global_cooldown_seconds, maxPerStream: remote.max_per_stream,
              maxPerUserPerStream: remote.max_per_user_per_stream, isEnabled: remote.is_enabled,
            }, now);
          } else if (Number.isFinite(reconcileTimestamp) && Number.isFinite(Date.parse(reward.updatedAt)) &&
              reconcileTimestamp - Date.parse(reward.updatedAt) >= CREATING_REWARD_MAX_AGE_MS) {
            await repository.deleteCreatingReward(channelId, reward.id);
          }
        } catch {
          fail(reward.twitchRewardId, "unknown_status");
        }
      }
      rewards = await repository.listRewards(channelId);
      for (const reward of rewards.filter(({ twitchState }) => twitchState !== "creating")) {
        const remote = manageableById.get(reward.twitchRewardId);
        try {
          if (remote === undefined) {
            await confirmTwitchRewardDeleted(environment, channelId, reward.twitchRewardId, now);
          } else {
            await repository.adoptTwitchReward(channelId, {
              id: remote.id, title: remote.title, prompt: remote.prompt, cost: remote.cost,
              backgroundColor: remote.background_color, isUserInputRequired: remote.is_user_input_required,
              globalCooldownSeconds: remote.global_cooldown_seconds, maxPerStream: remote.max_per_stream,
              maxPerUserPerStream: remote.max_per_user_per_stream, isEnabled: remote.is_enabled,
            }, now);
          }
        } catch {
          fail(reward.twitchRewardId, "unknown_status");
        }
      }
      rewards = await repository.listRewards(channelId);
    }
  } catch {
    for (const reward of rewards) if (reward.twitchState === "active") fail(reward.twitchRewardId, "unknown_status");
  }

  // Step 2: settle known open rows from Twitch before attempting any retry.
  const openRows = await repository.listOpenRedemptions(channelId, expiredBeforeFor(now));
  const confirmedUnfulfilledIds = new Set<string>();
  const helix = await loadHelix();
  const openRowsByTwitchReward = new Map<string, ChannelPointsRedemption[]>();
  for (const row of openRows) {
    const group = openRowsByTwitchReward.get(row.twitchRewardId) ?? [];
    group.push(row);
    openRowsByTwitchReward.set(row.twitchRewardId, group);
  }
  for (const [twitchRewardId, rewardRows] of openRowsByTwitchReward) {
    for (let offset = 0; offset < rewardRows.length; offset += 50) {
      const batch = rewardRows.slice(offset, offset + 50);
      const rowsById = new Map(batch.map((row) => [row.redemptionId, row]));
      try {
        const result = await helix.listRedemptionsByIds(
          environment, channelId, twitchRewardId, batch.map(({ redemptionId }) => redemptionId), authorize,
        );
        if (!result.ok) {
          if (result.reason === "not_found") {
            await confirmTwitchRewardDeleted(environment, channelId, twitchRewardId, now);
          } else fail(twitchRewardId, result.reason);
          continue;
        }
        for (const item of result.data) {
          const row = rowsById.get(item.id);
          if (row === undefined) continue;
          const status = helixRedemptionStatus(item.status);
          if (status === "unfulfilled") {
            confirmedUnfulfilledIds.add(item.id);
            continue;
          }
          if (status === "unknown") continue;
          const terminalStatus = status === "fulfilled" ? "fulfilled" : "refunded";
          const expectedStatus = row.status === "fulfilled" ? "fulfilled"
            : row.status === "refunded" ? "canceled"
              : row.pendingTwitchStatus === "FULFILLED" ? "fulfilled"
                : row.pendingTwitchStatus === "CANCELED" ? "canceled" : null;
          const mismatch = expectedStatus !== null && expectedStatus !== status;
          const mismatchReason = mismatch ? {
            de: `Twitch hat ${status === "fulfilled" ? "erledigt" : "erstattet"} gemeldet, obwohl BroBot ${expectedStatus === "fulfilled" ? "Erledigung" : "Erstattung"} gespeichert hatte.`,
            en: `Twitch reported ${status === "fulfilled" ? "fulfilled" : "refunded"} while BroBot had recorded ${expectedStatus === "fulfilled" ? "fulfilled" : "refunded"}.`,
          } : null;
          const outcomeReason = mismatchReason === null ? row.outcomeReason : {
            de: [row.outcomeReason?.de, mismatchReason.de].filter(Boolean).join(" "),
            en: [row.outcomeReason?.en, mismatchReason.en].filter(Boolean).join(" "),
          };
          await repository.updateRedemption(channelId, row.redemptionId, {
            status: terminalStatus, pendingTwitchStatus: null, outcomeReason, claimedAt: null,
          }, redemptionStatuses, now);
        }
      } catch {
        fail(twitchRewardId, "unknown_status");
      }
    }
  }

  // Step 3: latch new UNFULFILLED items; queue mode is persisted in the latch itself.
  const activeRewards = rewards.filter((reward) => reward.twitchState === "active" &&
    (manageableIds === null || manageableIds.has(reward.twitchRewardId)));
  for (const reward of activeRewards) {
    try {
      const result = await helix.listUnfulfilledRedemptions(environment, channelId, reward.twitchRewardId, authorize);
      if (!result.ok) {
        if (result.reason === "not_found") {
          await confirmTwitchRewardDeleted(environment, channelId, reward.twitchRewardId, now);
        } else fail(reward.twitchRewardId, result.reason);
        continue;
      }
      for (const item of result.data) {
        const redemption = redemptionRecord(item);
        confirmedUnfulfilledIds.add(redemption.id);
        const existing = await repository.getRedemption(channelId, redemption.id);
        if (existing !== null) continue;
        await persistFromAction(environment, channelId, reward, redemption, options.context ?? null, authorize);
      }
    } catch {
      fail(reward.twitchRewardId, "unknown_status");
    }
  }

  // Step 4: recover only actionable rows. A received row on a queue reward is latched into the queue.
  for (const row of await repository.listRetryable(channelId, expiredBeforeFor(now))) {
    try {
      if (!confirmedUnfulfilledIds.has(row.redemptionId)) continue;
      if (row.status === "failed_to_update" && row.pendingTwitchStatus === null) continue;
      const reward = await repository.getReward(channelId, row.rewardId);
      if (reward === null) continue;
      if (row.twitchRewardId !== reward.twitchRewardId) continue;
      if (row.status === "received" && reward.mode === "queue") {
        await repository.updateRedemption(channelId, row.redemptionId, {
          status: "queued", pendingTwitchStatus: null, claimedAt: null,
        }, ["received"], now);
        continue;
      }
      if (reward.twitchState !== "active") continue;
      if (manageableIds !== null && !manageableIds.has(reward.twitchRewardId)) continue;
      await retryExisting(environment, channelId, row, reward, options.context ?? null, authorize, now);
    } catch {
      fail(row.rewardId, "unknown_status");
    }
  }
  await repository.persistReconcileTime(channelId, now);
  return failures.size === 0
    ? "success"
    : { failedRewards: [...failures].map(([rewardId, reason]) => ({ rewardId, reason })) };
};

type LifecycleActor = ModuleMutationActor;
type ChannelPointsLifecycleInvocation =
  | { kind: "event"; event: ModuleEvent }
  | { kind: "reconcile"; actor: LifecycleActor; now: string; force: boolean }
  | { kind: "redemption.run"; actor: LifecycleActor; now: string; id: string }
  | { kind: "redemption.refund"; actor: LifecycleActor; now: string; id: string }
  | { kind: "reward.create"; actor: LifecycleActor; now: string; id: string; reward: ChannelPointsRewardInput }
  | { kind: "reward.update"; actor: LifecycleActor; now: string; id: string; reward: ChannelPointsRewardInput }
  | { kind: "reward.delete"; actor: LifecycleActor; now: string; id: string }
  | { kind: "reward.recreate"; actor: LifecycleActor; now: string; id: string }
  | { kind: "activation"; actor: LifecycleActor };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const lifecycleActor = (value: unknown): LifecycleActor | null => {
  if (!isRecord(value) || typeof value.userId !== "string") return null;
  return {
    userId: value.userId,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
  };
};

const mutationGuardFor = (
  channelId: string,
  actor: LifecycleActor,
  now: string,
  authorize: AuthorizeModuleMutation,
) => authorize(channelId, actor, now);

const authorizeCurrentMutation = (
  db: D1Database,
  channelId: string,
  actor: LifecycleActor,
  mutationAuthorization: AuthorizeModuleMutation,
): ChannelPointsMutationAuthorization => async () => {
  const guard = mutationGuardFor(channelId, actor, new Date().toISOString(), mutationAuthorization);
  return await db.prepare(`SELECT channel_id FROM channels WHERE channel_id = ? ${guard.sql}`)
    .bind(channelId, ...guard.values).first<{ channel_id: string }>() !== null;
};

const managementWriteGuard = (
  channelId: string,
  actor: LifecycleActor,
  authorizeManagementMutation: AuthorizeModuleMutation,
) => mutationGuardFor(channelId, actor, new Date().toISOString(), authorizeManagementMutation);

const moduleIsEnabled = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare("SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = ?")
    .bind(channelId, "channel_points").first<{ enabled: number }>())?.enabled === 1;

type QueueOperationResult =
  | { ok: true; status: "pending" | "fulfilled" | "refunded" }
  | { ok: false; error: "channel_points_module_disabled" | "channel_points_redemption_not_queued"; status?: ChannelPointsRedemptionStatus | null }
  | { ok: false; error: "channel_points_already_resolved_on_twitch"; status: "fulfilled" | "refunded" }
  | { ok: false; error: "channel_points_twitch_status_unavailable" | "channel_points_redemption_missing_on_twitch" }
  | { ok: false; reason: ChannelPointsHelixReason };

const performQueueOperation = async (
  environment: Env,
  channelId: string,
  invocation: Extract<ChannelPointsLifecycleInvocation, { kind: "redemption.run" | "redemption.refund" }>,
  authorizeMutation: AuthorizeModuleMutation,
): Promise<QueueOperationResult> => {
  const db = environment.DB;
  const authorize = authorizeCurrentMutation(db, channelId, invocation.actor, authorizeMutation);
  if (!await authorize()) return { ok: false, reason: "precondition_failed" };
  const repository = createChannelPointsRepository(db);
  const current = await repository.getRedemption(channelId, invocation.id);
  if (current?.status !== "queued") {
    return {
      ok: false,
      error: "channel_points_redemption_not_queued",
      status: current?.status ?? null,
    };
  }
  if (!await moduleIsEnabled(db, channelId)) return { ok: false, error: "channel_points_module_disabled" };

  const now = invocation.now;
  const claimGuard = mutationGuardFor(channelId, invocation.actor, new Date().toISOString(), authorizeMutation);
  const claimed = await repository.claimRedemption(
    channelId, invocation.id, ["queued"], expiredBeforeFor(now), now, claimGuard,
    invocation.kind === "redemption.refund"
      ? { pendingTwitchStatus: "CANCELED", outcomeReason: operatorRefundReason }
      : undefined,
  );
  if (!claimed) {
    if (!await authorize()) return { ok: false, reason: "precondition_failed" };
    const current = await repository.getRedemption(channelId, invocation.id);
    return {
      ok: false,
      error: "channel_points_redemption_not_queued",
      status: current?.status ?? null,
    };
  }

  const redemption = await repository.getRedemption(channelId, invocation.id);
  if (redemption === null || redemption.status !== "running") {
    return {
      ok: false,
      error: "channel_points_redemption_not_queued",
      status: redemption?.status ?? null,
    };
  }
  if (invocation.kind === "redemption.refund") {
    return await applyOutcome(environment, channelId, redemption.twitchRewardId, redemption.redemptionId,
      { refund: operatorRefundReason }, now, authorize);
  }

  const helix = await loadHelix();
  let statusResult: Awaited<ReturnType<typeof helix.listRedemptionsByIds>>;
  try {
    statusResult = await helix.listRedemptionsByIds(
      environment, channelId, redemption.twitchRewardId, [redemption.redemptionId], authorize,
    );
  } catch {
    await repository.updateRedemption(channelId, redemption.redemptionId, {
      status: "queued", pendingTwitchStatus: null, outcomeReason: null, claimedAt: null,
    }, ["running"], now);
    return { ok: false, error: "channel_points_twitch_status_unavailable" };
  }
  if (!statusResult.ok) {
    if (statusResult.reason === "not_found") {
      await confirmTwitchRewardDeleted(environment, channelId, redemption.twitchRewardId, now);
      return { ok: false, error: "channel_points_redemption_missing_on_twitch" };
    }
    await repository.updateRedemption(channelId, redemption.redemptionId, {
      status: "queued", pendingTwitchStatus: null, outcomeReason: null, claimedAt: null,
    }, ["running"], now);
    return { ok: false, error: "channel_points_twitch_status_unavailable" };
  }
  const remoteRedemption = statusResult.data.find(({ id }) => id === redemption.redemptionId);
  if (remoteRedemption === undefined) {
    await repository.updateRedemption(channelId, redemption.redemptionId, {
      status: "orphaned", pendingTwitchStatus: null, outcomeReason: missingTwitchRedemptionReason, claimedAt: null,
    }, ["running"], now);
    return { ok: false, error: "channel_points_redemption_missing_on_twitch" };
  }
  const remoteStatus = helixRedemptionStatus(remoteRedemption.status);
  if (remoteStatus !== "unfulfilled") {
    const status = remoteStatus === "fulfilled" ? "fulfilled" : "refunded";
    await repository.updateRedemption(channelId, redemption.redemptionId, {
      status, pendingTwitchStatus: null, outcomeReason: redemption.outcomeReason, claimedAt: null,
    }, ["running"], now);
    return { ok: false, error: "channel_points_already_resolved_on_twitch", status };
  }

  const reward = await repository.getReward(channelId, redemption.rewardId);
  if (reward === null) return { ok: false, reason: "unknown_status" };
  return await runClaimedAction(environment, channelId, reward, redemption, null, authorize);
};

type RewardOperationResult =
  | { ok: true; reward: ChannelPointsReward }
  | { ok: true }
  | { ok: false; error: "channel_points_module_disabled" | "channel_points_reward_not_found" | "channel_points_reward_deleted" | "channel_points_reward_not_deleted" }
  | { ok: false; reason: ChannelPointsHelixReason };

const performRewardMutation = async (
  environment: Env,
  channelId: string,
  invocation: Exclude<ChannelPointsLifecycleInvocation, { kind: "event" | "reconcile" | "activation" | "redemption.run" | "redemption.refund" }>,
  authorizeManagementMutation: AuthorizeModuleMutation,
): Promise<RewardOperationResult> => {
  const repository = createChannelPointsRepository(environment.DB);
  if (!await moduleIsEnabled(environment.DB, channelId)) return { ok: false, error: "channel_points_module_disabled" };
  const authorize = authorizeCurrentMutation(environment.DB, channelId, invocation.actor, authorizeManagementMutation);
  const helix = await loadHelix();

  if (invocation.kind === "reward.create") {
    const count = await environment.DB.prepare(
      "SELECT COUNT(*) AS count FROM channel_points_rewards WHERE channel_id = ? AND twitch_state IN ('creating','active')",
    ).bind(channelId).first<{ count: number }>();
    if ((count?.count ?? 0) >= CHANNEL_POINTS_MAX_REWARDS) return { ok: false, reason: "reward_limit" };
    const creationStartedAt = new Date().toISOString();
    const inserted = await repository.insertCreatingReward(
      channelId, invocation.reward, invocation.id, creationStartedAt,
      managementWriteGuard(channelId, invocation.actor, authorizeManagementMutation),
    );
    if (!inserted) return { ok: false, reason: "precondition_failed" };
    const watermark = new Date().toISOString();
    const created = await helix.createCustomReward(environment, channelId, invocation.reward, authorize);
    if (!created.ok) {
      await repository.deleteCreatingReward(channelId, invocation.id);
      return { ok: false, reason: created.reason };
    }
    const remote = created.data[0];
    if (remote === undefined) {
      await repository.deleteCreatingReward(channelId, invocation.id);
      return { ok: false, reason: "invalid_response" };
    }
    const saved = await repository.finalizeCreatingReward(
      channelId, invocation.id, remote.id, watermark,
      managementWriteGuard(channelId, invocation.actor, authorizeManagementMutation),
    );
    if (!saved) return { ok: false, reason: "precondition_failed" };
    const reward = await repository.getReward(channelId, invocation.id);
    return reward === null ? { ok: false, reason: "unknown_status" } : { ok: true, reward };
  }

  const current = await repository.getReward(channelId, invocation.id);
  if (current === null) return { ok: false, error: "channel_points_reward_not_found" };
  if (current.twitchState === "creating") return { ok: false, reason: "precondition_failed" };
  if (invocation.kind === "reward.update") {
    if (current.twitchState === "deleted_on_twitch") return { ok: false, error: "channel_points_reward_deleted" };
    const watermark = new Date().toISOString();
    const updated = await helix.updateCustomReward(
      environment, channelId, current.twitchRewardId, invocation.reward, authorize,
    );
    if (!updated.ok) {
      if (updated.reason === "not_found") {
        await confirmTwitchRewardDeleted(environment, channelId, current.twitchRewardId, watermark);
      }
      return { ok: false, reason: updated.reason };
    }
    const saved = await repository.updateReward(
      channelId, current.id, invocation.reward, watermark,
      managementWriteGuard(channelId, invocation.actor, authorizeManagementMutation),
    );
    if (!saved) return { ok: false, reason: "precondition_failed" };
    const reward = await repository.getReward(channelId, current.id);
    return reward === null ? { ok: false, reason: "unknown_status" } : { ok: true, reward };
  }
  if (invocation.kind === "reward.delete") {
    if (current.twitchState !== "deleted_on_twitch") {
      const deleted = await helix.deleteCustomReward(environment, channelId, current.twitchRewardId, authorize);
      if (!deleted.ok) {
        if (deleted.reason !== "not_found") return { ok: false, reason: deleted.reason };
        await confirmTwitchRewardDeleted(environment, channelId, current.twitchRewardId, invocation.now);
      }
    }
    const saved = await repository.deleteReward(
      channelId, current.id, managementWriteGuard(channelId, invocation.actor, authorizeManagementMutation),
    );
    if (saved) await confirmTwitchRewardDeleted(environment, channelId, current.twitchRewardId, invocation.now);
    return saved ? { ok: true } : { ok: false, reason: "precondition_failed" };
  }
  if (current.twitchState !== "deleted_on_twitch") return { ok: false, error: "channel_points_reward_not_deleted" };
  const created = await helix.createCustomReward(environment, channelId, current, authorize);
  if (!created.ok) return { ok: false, reason: created.reason };
  const remote = created.data[0];
  if (remote === undefined) return { ok: false, reason: "invalid_response" };
  const saved = await repository.replaceTwitchId(
    channelId, current.id, remote.id, invocation.now,
    managementWriteGuard(channelId, invocation.actor, authorizeManagementMutation),
  );
  if (!saved) return { ok: false, reason: "precondition_failed" };
  const reward = await repository.getReward(channelId, current.id);
  return reward === null ? { ok: false, reason: "unknown_status" } : { ok: true, reward };
};

const activationSync = async (
  environment: Env,
  channelId: string,
  actor: LifecycleActor,
  authorizeManagementMutation: AuthorizeModuleMutation,
): Promise<{ ok: false; error: string; failedRewards: readonly { rewardId: string; reason: string }[] } | undefined> => {
  const db = environment.DB;
  const enabled = await moduleIsEnabled(db, channelId);
  const now = new Date().toISOString();
  const guard = managementWriteGuard(channelId, actor, authorizeManagementMutation);
  const rows = await db.prepare(
    "SELECT id,twitch_reward_id,enabled,restore_enabled FROM channel_points_rewards WHERE channel_id=? AND twitch_state='active'",
  ).bind(channelId).all<{ id: string; twitch_reward_id: string; enabled: number; restore_enabled: number | null }>();
  const failures: Array<{ rewardId: string; reason: string }> = [];
  if (!enabled) {
    await db.prepare(
      `UPDATE channel_points_rewards
          SET restore_enabled=COALESCE(restore_enabled,enabled),enabled=0,updated_at=?
        WHERE channel_id=? AND twitch_state='active'
          AND EXISTS (SELECT channel_id FROM channels WHERE channel_id=? ${guard.sql})`,
    ).bind(now, channelId, channelId, ...guard.values).run();
  }
  const { setCustomRewardEnabled } = await loadHelix();
  const authorize = authorizeCurrentMutation(db, channelId, actor, authorizeManagementMutation);
  for (const row of rows.results) {
    const desired = enabled ? (row.restore_enabled ?? row.enabled) === 1 : false;
    try {
      if (!await authorize()) {
        failures.push({ rewardId: row.twitch_reward_id, reason: "precondition_failed" });
        continue;
      }
      const result = await setCustomRewardEnabled(environment, channelId, row.twitch_reward_id, desired, authorize);
      if (!result.ok) {
        if (result.reason === "not_found") {
          await confirmTwitchRewardDeleted(environment, channelId, row.twitch_reward_id, new Date().toISOString());
          continue;
        }
        failures.push({ rewardId: row.twitch_reward_id, reason: result.reason });
        continue;
      }
      const currentGuard = managementWriteGuard(channelId, actor, authorizeManagementMutation);
      const synchronizedAt = new Date().toISOString();
      const write = await db.prepare(
        `UPDATE channel_points_rewards
            SET enabled=CASE WHEN ?=1 THEN ? ELSE enabled END,
                restore_enabled=CASE WHEN ?=1 THEN NULL ELSE restore_enabled END,
                last_twitch_event_at=?,updated_at=?
          WHERE channel_id=? AND id=? AND EXISTS (SELECT channel_id FROM channels WHERE channel_id=? ${currentGuard.sql})`,
      ).bind(Number(enabled), Number(desired), Number(enabled), synchronizedAt, synchronizedAt,
        channelId, row.id, channelId, ...currentGuard.values).run();
      if (write.meta.changes === 0) failures.push({ rewardId: row.twitch_reward_id, reason: "precondition_failed" });
    } catch {
      failures.push({ rewardId: row.twitch_reward_id, reason: "unknown_status" });
    }
  }
  return failures.length === 0
    ? undefined
    : { ok: false, error: "channel_points_activation_sync_failed", failedRewards: failures };
};

const decodeLifecycleInvocation = (value: unknown): ChannelPointsLifecycleInvocation | null => {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "event" && isRecord(value.event) && typeof value.event.channelId === "string") {
    return { kind: "event", event: value.event as unknown as ModuleEvent };
  }
  const actor = lifecycleActor(value.actor);
  if (value.kind === "activation" && actor !== null) return { kind: "activation", actor };
  if (value.kind === "reconcile" && actor !== null && typeof value.now === "string") {
    return { kind: "reconcile", actor, now: value.now, force: value.force === true };
  }
  if ((value.kind === "redemption.run" || value.kind === "redemption.refund") && actor !== null &&
      typeof value.id === "string" && typeof value.now === "string") {
    return { kind: value.kind, actor, id: value.id, now: value.now };
  }
  if (value.kind === "reward.delete" && actor !== null && typeof value.id === "string" && typeof value.now === "string") {
    return { kind: "reward.delete", actor, id: value.id, now: value.now };
  }
  if (value.kind === "reward.recreate" && actor !== null && typeof value.id === "string" && typeof value.now === "string") {
    return { kind: "reward.recreate", actor, id: value.id, now: value.now };
  }
  if ((value.kind === "reward.create" || value.kind === "reward.update") && actor !== null &&
      typeof value.id === "string" && typeof value.now === "string") {
    const reward = channelPointsRewardInputSchema.safeParse(value.reward);
    if (!reward.success) return null;
    return { kind: value.kind, actor, id: value.id, now: value.now, reward: reward.data };
  }
  return null;
};

export const channelPointsLifecycleAlarm: ModuleAlarmDefinition = {
  key: CHANNEL_POINTS_LIFECYCLE_HANDLER,
  handle: async (context: ModuleAlarmContext, _alarmKey: string, _deadline: number, _revision, rawInvocation) => {
    const invocation = decodeLifecycleInvocation(rawInvocation);
    const environment = context.environment;
    if (invocation === null || environment === undefined || context.authorizeMutation === undefined ||
        context.authorizeManagementMutation === undefined) {
      throw new Error("Channel-points lifecycle invocation is invalid.");
    }
    const channelId = context.channelId;
    if (invocation.kind === "event") {
      if (invocation.event.channelId !== channelId) throw new Error("Channel-points event crossed its channel boundary.");
      return await processChannelPointsEventInLane(invocation.event, environment, null);
    }
    if (invocation.kind === "activation") {
      return await activationSync(environment, channelId, invocation.actor, context.authorizeManagementMutation);
    }
    if (invocation.kind === "reconcile") {
      const authorize = authorizeCurrentMutation(environment.DB, channelId, invocation.actor, context.authorizeMutation);
      if (!await authorize()) return "precondition_failed";
      if (!await moduleIsEnabled(environment.DB, channelId)) return { error: "channel_points_module_disabled" };
      return await reconcileChannelPoints(environment, channelId, invocation.now, {
        force: invocation.force, authorize,
      });
    }
    if (invocation.kind === "redemption.run" || invocation.kind === "redemption.refund") {
      return await performQueueOperation(environment, channelId, invocation, context.authorizeMutation);
    }
    return await performRewardMutation(environment, channelId, invocation, context.authorizeManagementMutation);
  },
};
