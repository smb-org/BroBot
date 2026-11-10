import type { ChannelPointsRedemptionStatus, ChannelPointsRewardMode, HelixRedemption, TwitchRedemptionStatus } from "../contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** Parses an EventSub redemption with Twitch's optional string fields treated as nullable. */
export const redemptionFromEventSub = (value: unknown): {
  id: string; rewardId: string; rewardTitle: string; userId: string; userLogin: string;
  userName: string; userInput: string; redeemedAt: string;
} | null => {
  const input = record(value);
  const reward = record(input?.["reward"]);
  if (input === null || reward === null || typeof input["id"] !== "string" || typeof reward["id"] !== "string") return null;
  return {
    id: input["id"], rewardId: reward["id"], rewardTitle: text(reward["title"]),
    userId: text(input["user_id"]), userLogin: text(input["user_login"]), userName: text(input["user_name"]),
    userInput: text(input["user_input"]), redeemedAt: text(input["redeemed_at"]),
  };
};

/** Converts a reward event to the Twitch-owned fields persisted by BroBot. */
export const rewardSnapshotFromEventSub = (value: unknown): {
  twitchRewardId: string; title: string; prompt: string | null; cost: number; backgroundColor: string | null;
  isUserInputRequired: boolean; globalCooldownSeconds: number | null; maxPerStream: number | null;
  maxPerUserPerStream: number | null; enabled: boolean;
} | null => {
  const input = record(value);
  const globalCooldown = record(input?.["global_cooldown"]);
  const maxPerStream = record(input?.["max_per_stream"]);
  const maxPerUserPerStream = record(input?.["max_per_user_per_stream"]);
  const cost = integer(input?.["cost"]);
  if (input === null || typeof input["id"] !== "string" || typeof input["title"] !== "string" ||
      cost === null || typeof input["is_enabled"] !== "boolean") return null;
  return {
    twitchRewardId: input["id"], title: input["title"], prompt: typeof input["prompt"] === "string" ? input["prompt"] : null,
    cost, backgroundColor: typeof input["background_color"] === "string" ? input["background_color"] : null,
    isUserInputRequired: input["is_user_input_required"] === true,
    globalCooldownSeconds: globalCooldown?.["is_enabled"] === true ? integer(globalCooldown["seconds"]) : null,
    maxPerStream: maxPerStream?.["is_enabled"] === true ? integer(maxPerStream["value"]) : null,
    maxPerUserPerStream: maxPerUserPerStream?.["is_enabled"] === true
      ? integer(maxPerUserPerStream["value"]) : null,
    enabled: input["is_enabled"],
  };
};

export const redemptionFromHelix = (item: HelixRedemption) => ({
  id: item.id, rewardId: item.reward.id, rewardTitle: item.reward.title,
  userId: item.user_id, userLogin: item.user_login, userName: item.user_name,
  userInput: item.user_input, redeemedAt: item.redeemed_at,
});

export type ChannelPointsActionOutcome = "fulfilled" | { refund: { de: string; en: string } } | "pending";

/** Determines the persisted lifecycle state before any Twitch status update is attempted. */
export const channelPointsActionTransition = (
  mode: ChannelPointsRewardMode,
  outcome: ChannelPointsActionOutcome,
): { status: ChannelPointsRedemptionStatus; pendingTwitchStatus?: TwitchRedemptionStatus; outcomeReason?: { de: string; en: string } } => {
  if (mode === "queue") return { status: "queued" };
  if (outcome === "pending") return { status: "pending" };
  if (outcome === "fulfilled") return { status: "running", pendingTwitchStatus: "FULFILLED" };
  return { status: "running", pendingTwitchStatus: "CANCELED", outcomeReason: outcome.refund };
};
