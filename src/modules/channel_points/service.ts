import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import type { ChannelPointsActionOutcome } from "./domain/redemption";
import { channelPointsActionTransition, redemptionFromEventSub, redemptionFromHelix, rewardSnapshotFromEventSub } from "./domain/redemption";
import type {
  ChannelPointsRedemption,
  ChannelPointsRedemptionStatus,
  ChannelPointsReward,
  ChannelPointsHelixReason,
  HelixRedemption,
  TwitchRedemptionStatus,
} from "./contracts";
import { createChannelPointsRepository } from "./repository";

const loadHelix = () => import("../../worker/twitch/channel-points");
const loadActionContext = () => import("../../worker/module-action-context");
const RECONCILE_INTERVAL_MS = 15_000;
const REDEMPTION_CLAIM_LEASE_MS = 2 * 60 * 1_000;
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
export type ChannelPointsMutationAuthorization = () => Promise<boolean>;

const expiredBeforeFor = (now: string): string => {
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp) ? new Date(timestamp - REDEMPTION_CLAIM_LEASE_MS).toISOString() : now;
};

const sendStatus = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  redemptionId: string,
  status: "FULFILLED" | "CANCELED",
  authorize: ChannelPointsMutationAuthorization,
): Promise<"success" | ChannelPointsHelixReason> => {
  const result = await (await loadHelix()).updateRedemptionStatus(
    environment, channelId, reward.twitchRewardId, [redemptionId], status, authorize,
  );
  return result.ok ? "success" : result.reason;
};

const applyOutcome = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  redemptionId: string,
  outcome: ChannelPointsActionOutcome,
  now: string,
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const transition = channelPointsActionTransition("auto", outcome);
  const recorded = await repository.updateRedemption(channelId, redemptionId, {
    status: transition.status,
    pendingTwitchStatus: transition.pendingTwitchStatus ?? null,
    outcomeReason: transition.outcomeReason ?? null,
    claimedAt: transition.status === "pending" || transition.status === "running" ? now : null,
  }, ["running"], now);
  if (!recorded || transition.pendingTwitchStatus === undefined) return;
  const patched = await sendStatus(environment, channelId, reward, redemptionId, transition.pendingTwitchStatus, authorize);
  const finishedAt = new Date().toISOString();
  if (patched === "success") {
    await repository.updateRedemption(channelId, redemptionId, {
      status: transition.pendingTwitchStatus === "FULFILLED" ? "fulfilled" : "refunded",
      pendingTwitchStatus: null,
      outcomeReason: transition.outcomeReason ?? null,
      claimedAt: null,
    }, ["running"], finishedAt);
  } else {
    await repository.updateRedemption(channelId, redemptionId, {
      status: "failed_to_update",
      pendingTwitchStatus: transition.pendingTwitchStatus,
      outcomeReason: transition.outcomeReason ?? null,
      claimedAt: finishedAt,
    }, ["running"], finishedAt);
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
  alreadyLatched: boolean,
): Promise<void> => {
  const repository = createChannelPointsRepository(environment.DB);
  const now = new Date().toISOString();
  if (!alreadyLatched && !await repository.latchRedemption(channelId, { ...redemption, rewardId: reward.id }, now)) return;
  if (reward.mode === "queue") {
    await repository.updateRedemption(channelId, redemption.id, {
      status: "queued", pendingTwitchStatus: null, claimedAt: null,
    }, ["received"], now);
    return;
  }
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
  await persistFromAction(environment, channelId, reward, redemption, context, authorize, false);
};

const persistTwitchTerminalStatus = async (
  environment: Env,
  channelId: string,
  redemption: NonNullable<ReturnType<typeof redemptionFromEventSub>>,
  status: unknown,
  now: string,
): Promise<void> => {
  if (status !== "FULFILLED" && status !== "CANCELED") return;
  const repository = createChannelPointsRepository(environment.DB);
  const saved = await repository.getRedemption(channelId, redemption.id);
  if (saved === null) return;
  const reportedStatus: TwitchRedemptionStatus = status;
  const expectedStatus = saved.status === "fulfilled" ? "FULFILLED"
    : saved.status === "refunded" ? "CANCELED"
      : saved.pendingTwitchStatus;
  const mismatch = expectedStatus !== null && expectedStatus !== reportedStatus;
  const mismatchReason = mismatch ? {
    de: `Twitch hat ${reportedStatus === "FULFILLED" ? "erledigt" : "erstattet"} gemeldet, obwohl BroBot ${expectedStatus === "FULFILLED" ? "Erledigung" : "Erstattung"} gespeichert hatte.`,
    en: `Twitch reported ${reportedStatus === "FULFILLED" ? "fulfilled" : "refunded"} while BroBot had recorded ${expectedStatus === "FULFILLED" ? "fulfilled" : "refunded"}.`,
  } : null;
  const outcomeReason = mismatchReason === null ? saved.outcomeReason : {
    de: [saved.outcomeReason?.de, mismatchReason.de].filter(Boolean).join(" "),
    en: [saved.outcomeReason?.en, mismatchReason.en].filter(Boolean).join(" "),
  };
  await repository.updateRedemption(channelId, redemption.id, {
    status: status === "FULFILLED" ? "fulfilled" : "refunded",
    pendingTwitchStatus: null,
    outcomeReason,
    claimedAt: null,
  }, redemptionStatuses, now);
};

export const processChannelPointsEvent = async (
  event: ModuleEvent,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  const environment = context.environment;
  if (environment === undefined) return noResult;
  const repository = createChannelPointsRepository(context.DB);
  const now = event.eventSubTimestamp ?? event.receivedAt;
  if (event.subscriptionType === "channel.channel_points_custom_reward_redemption.add") {
    const redemption = redemptionFromEventSub(event.payload);
    if (redemption !== null) {
      await processNewRedemption(environment, event.channelId, redemption, context, () => Promise.resolve(true));
    }
  } else if (event.subscriptionType === "channel.channel_points_custom_reward_redemption.update") {
    const redemption = redemptionFromEventSub(event.payload);
    if (redemption !== null) await persistTwitchTerminalStatus(
      environment, event.channelId, redemption, event.payload["status"], now,
    );
  } else if (event.subscriptionType === "channel.channel_points_custom_reward.update") {
    const reward = rewardSnapshotFromEventSub(event.payload);
    if (reward !== null && await repository.getRewardByTwitchId(event.channelId, reward.twitchRewardId) !== null) {
      await repository.adoptTwitchReward(event.channelId, {
        id: reward.twitchRewardId, title: reward.title, prompt: reward.prompt, cost: reward.cost,
        backgroundColor: reward.backgroundColor, isUserInputRequired: reward.isUserInputRequired,
        globalCooldownSeconds: reward.globalCooldownSeconds, maxPerStream: reward.maxPerStream,
        maxPerUserPerStream: reward.maxPerUserPerStream, isEnabled: reward.enabled,
      }, now);
    }
  } else if (event.subscriptionType === "channel.channel_points_custom_reward.remove") {
    const twitchRewardId = typeof event.payload["id"] === "string" ? event.payload["id"] : "";
    if (twitchRewardId !== "" && await repository.getRewardByTwitchId(event.channelId, twitchRewardId) !== null) {
      await repository.markRewardDeleted(event.channelId, twitchRewardId, now);
    }
  }
  return noResult;
};

const redemptionRecord = (item: HelixRedemption) => redemptionFromHelix(item);

const runClaimedAction = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  row: ChannelPointsRedemption,
  context: ModuleExecutionContext | null,
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const redemption = {
    id: row.redemptionId, rewardId: reward.twitchRewardId, rewardTitle: row.rewardTitle, userId: row.userId,
    userLogin: row.userLogin, userName: row.userName, userInput: row.userInput, redeemedAt: row.redeemedAt,
  };
  const outcome = await actionOutcome(environment, channelId, reward, redemption, context);
  await applyOutcome(environment, channelId, reward, row.redemptionId, outcome, new Date().toISOString(), authorize);
};

const sendPendingTwitchPatch = async (
  environment: Env,
  channelId: string,
  reward: ChannelPointsReward,
  row: ChannelPointsRedemption,
  expectedStatus: "running" | "failed_to_update",
  authorize: ChannelPointsMutationAuthorization,
): Promise<void> => {
  const pendingStatus = row.pendingTwitchStatus;
  if (pendingStatus === null) return;
  const patched = await sendStatus(environment, channelId, reward, row.redemptionId, pendingStatus, authorize);
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
      await sendPendingTwitchPatch(environment, channelId, reward, claimed, "failed_to_update", authorize);
    }
    return;
  }
  let claimed: boolean;
  if (row.status === "running") {
    claimed = await repository.reclaimRunningRedemption(channelId, row.redemptionId, expiredBefore, now);
  } else if (row.status === "received" || row.status === "pending" || row.status === "queued") {
    claimed = await repository.claimRedemption(channelId, row.redemptionId, [row.status], expiredBefore, now);
  } else {
    return;
  }
  if (!claimed) return;
  const current = await repository.getRedemption(channelId, row.redemptionId);
  if (current === null || current.status !== "running") return;
  if (current.pendingTwitchStatus !== null) {
    await sendPendingTwitchPatch(environment, channelId, reward, current, "running", authorize);
    return;
  }
  await runClaimedAction(environment, channelId, reward, current, context, authorize);
};

export const reconcileChannelPoints = async (
  environment: Env,
  channelId: string,
  now: string,
  options: { force?: boolean; authorize?: ChannelPointsMutationAuthorization; context?: ModuleExecutionContext | null } = {},
): Promise<ChannelPointsHelixReason | "success"> => {
  const repository = createChannelPointsRepository(environment.DB);
  const previous = await repository.lastReconciledAt(channelId);
  const last = previous === null ? NaN : Date.parse(previous);
  const current = Date.parse(now);
  if (!options.force && Number.isFinite(last) && Number.isFinite(current) && current - last < RECONCILE_INTERVAL_MS) return "success";
  const authorize = options.authorize ?? (() => Promise.resolve(true));
  const rewards = await repository.listRewards(channelId);
  for (const reward of rewards) {
    if (reward.twitchState !== "active") continue;
    const result = await (await loadHelix()).listUnfulfilledRedemptions(environment, channelId, reward.twitchRewardId, authorize);
    if (!result.ok) return result.reason;
    for (const item of result.data) {
      const redemption = redemptionRecord(item);
      const existing = await repository.getRedemption(channelId, redemption.id);
      if (existing === null) {
        await persistFromAction(environment, channelId, reward, redemption, options.context ?? null, authorize, false);
      }
    }
  }
  for (const row of await repository.listRetryable(channelId, expiredBeforeFor(now))) {
    if (row.status === "failed_to_update" && row.pendingTwitchStatus === null) continue;
    const reward = await repository.getReward(channelId, row.rewardId);
    if (reward !== null) await retryExisting(environment, channelId, row, reward, options.context ?? null, authorize, now);
  }
  await repository.persistReconcileTime(channelId, now);
  return "success";
};
