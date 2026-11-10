import { z } from "zod";

export const CHANNEL_POINTS_MODULE_ID = "channel_points";
export const CHANNEL_POINTS_MAX_REWARDS = 50;

export const channelPointsRewardInputSchema = z.object({
  title: z.string().trim().min(1).max(45),
  prompt: z.string().trim().max(200).nullable(),
  cost: z.number().int().min(1).max(1_000_000),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u).nullable(),
  isUserInputRequired: z.boolean(),
  globalCooldownSeconds: z.number().int().min(1).max(604_800).nullable(),
  maxPerStream: z.number().int().min(1).max(1_000_000).nullable(),
  maxPerUserPerStream: z.number().int().min(1).max(1_000_000).nullable(),
  actionModuleId: z.string().min(1),
  actionId: z.string().min(1),
  actionConfig: z.record(z.string(), z.unknown()),
  mode: z.enum(["auto", "queue"]),
  enabled: z.boolean(),
});

export type ChannelPointsRewardInput = z.output<typeof channelPointsRewardInputSchema>;
export type ChannelPointsRewardMode = "auto" | "queue";
export type ChannelPointsRedemptionStatus =
  | "received" | "running" | "queued" | "pending" | "fulfilled" | "refunded" | "failed_to_update" | "orphaned";
export type TwitchRedemptionStatus = "FULFILLED" | "CANCELED";
export type NormalizedTwitchRedemptionStatus = "unfulfilled" | "fulfilled" | "canceled" | "unknown";

export interface ChannelPointsReward extends ChannelPointsRewardInput {
  id: string;
  twitchRewardId: string;
  twitchState: "creating" | "active" | "deleted_on_twitch";
  createdAt: string;
  updatedAt: string;
}

export interface ChannelPointsRedemption {
  redemptionId: string;
  rewardId: string;
  twitchRewardId: string;
  rewardTitle: string;
  userId: string;
  userLogin: string;
  userName: string;
  userInput: string;
  redeemedAt: string;
  status: ChannelPointsRedemptionStatus;
  pendingTwitchStatus: TwitchRedemptionStatus | null;
  outcomeReason: { de: string; en: string } | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelPointsHelixReason =
  | "success" | "not_affiliate" | "reward_limit" | "duplicate_title" | "scope_missing"
  | "not_connected" | "token_unavailable" | "revoked" | "refresh_failed" | "precondition_failed"
  | "rate_limited" | "network" | "invalid_input" | "invalid_response" | "not_found" | "unknown_status";

export type ChannelPointsHelixResult<Data> = { ok: true; data: Data } | { ok: false; reason: ChannelPointsHelixReason };

export interface HelixCustomReward {
  id: string;
  title: string;
  prompt: string | null;
  cost: number;
  is_enabled: boolean;
  background_color: string | null;
  is_user_input_required: boolean;
  global_cooldown_seconds: number | null;
  max_per_stream: number | null;
  max_per_user_per_stream: number | null;
  is_max_per_stream_enabled?: boolean;
  is_max_per_user_per_stream_enabled?: boolean;
  is_global_cooldown_enabled?: boolean;
  is_paused: boolean | null;
  is_in_stock: boolean | null;
  should_redemptions_skip_request_queue: boolean | null;
}

export interface HelixRedemption {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  redeemed_at: string;
  status: "UNFULFILLED" | "FULFILLED" | "CANCELED";
  reward: { id: string; title: string };
}
