/**
 * Twitch Helix channel-points contracts used here:
 *
 * Create Custom Rewards
 *   POST /helix/channel_points/custom_rewards?broadcaster_id={broadcaster_id}
 *   Body: { title, cost, prompt?, is_enabled?, background_color?, is_user_input_required?,
 *     is_max_per_stream_enabled?, max_per_stream?, is_max_per_user_per_stream_enabled?,
 *     max_per_user_per_stream?, is_global_cooldown_enabled?, global_cooldown_seconds?,
 *     should_redemptions_skip_request_queue? }
 *   Response: { data: [CustomReward] }, where CustomReward is {
 *     id, broadcaster_id, broadcaster_login, broadcaster_name, title, prompt, cost, is_enabled,
 *     background_color, image?, default_image?, is_user_input_required, is_paused, is_in_stock,
 *     should_redemptions_skip_request_queue, redemptions_redeemed_current_stream?,
 *     global_cooldown_setting: { is_enabled, global_cooldown_seconds },
 *     max_per_stream_setting: { is_enabled, max_per_stream },
 *     max_per_user_per_stream_setting: { is_enabled, max_per_user_per_stream }
 *   }.
 *
 * Update Custom Reward
 *   PATCH /helix/channel_points/custom_rewards?broadcaster_id={broadcaster_id}&id={reward_id}
 *   Body: any partial subset of the create reward fields; response is { data: [CustomReward] }.
 * Delete Custom Reward
 *   DELETE /helix/channel_points/custom_rewards?broadcaster_id={broadcaster_id}&id={reward_id}
 *   Body: none; response: { data: [{ broadcaster_id, id }] }.
 * Get Custom Rewards
 *   GET /helix/channel_points/custom_rewards?broadcaster_id={broadcaster_id}&only_manageable_rewards=true
 *   Response: { data: [CustomReward] }.
 *   CustomReward includes global_cooldown_setting: { is_enabled, global_cooldown_seconds },
 *   max_per_stream_setting: { is_enabled, max_per_stream }, and
 *   max_per_user_per_stream_setting: { is_enabled, max_per_user_per_stream }.
 *
 * Update Custom Reward Redemption Status
 *   PATCH /helix/channel_points/custom_rewards/redemptions?id={redemption_id}[&id=...]&broadcaster_id={broadcaster_id}&reward_id={reward_id}
 *   Body: { status: "FULFILLED" | "CANCELED" }; response: { data: [Redemption] }.
 * Get Custom Reward Redemptions
 *   GET /helix/channel_points/custom_rewards/redemptions?broadcaster_id={broadcaster_id}&reward_id={reward_id}&status=UNFULFILLED&first={1..50}&after={cursor}
 *   Redemption: { id, broadcaster_id, broadcaster_login, broadcaster_name, user_id, user_login,
 *     user_name, user_input, status, redeemed_at, reward: { id, title, prompt, cost } }.
 *   Response: { data: [Redemption], pagination: { cursor? } }.
 *
 * EventSub reward events use global_cooldown: { is_enabled, seconds },
 * max_per_stream: { is_enabled, value }, and max_per_user_per_stream: { is_enabled, value }.
 * Redemption events include status and reward: { id, title, cost, prompt }.
 */
import { z } from "zod";

import type {
  ChannelPointsHelixReason, ChannelPointsHelixResult, ChannelPointsRewardInput,
  HelixCustomReward, HelixRedemption, TwitchRedemptionStatus,
} from "../../modules/channel_points/contracts";
import { withBroadcasterToken, type BroadcasterTokenResult } from "../auth/broadcaster-token";
import { helixRequest } from "./helix";

const REWARDS_URL = "https://api.twitch.tv/helix/channel_points/custom_rewards";
const REDEMPTIONS_URL = "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions";
const nullableString = z.string().nullish().transform((value) => value ?? null);
const nullableInteger = z.number().int().nullish().transform((value) => value ?? null);
const rewardSchema = z.object({
  id: z.string().min(1), title: z.string(), prompt: nullableString, cost: z.number().int().positive(),
  is_enabled: z.boolean(), background_color: nullableString,
  is_user_input_required: z.boolean().nullish().transform((value) => value ?? false),
  global_cooldown_setting: z.object({
    is_enabled: z.boolean().nullish().transform((value) => value ?? false),
    global_cooldown_seconds: nullableInteger,
  }).nullish().transform((value) => value ?? { is_enabled: false, global_cooldown_seconds: null }),
  max_per_stream_setting: z.object({
    is_enabled: z.boolean().nullish().transform((value) => value ?? false),
    max_per_stream: nullableInteger,
  }).nullish().transform((value) => value ?? { is_enabled: false, max_per_stream: null }),
  max_per_user_per_stream_setting: z.object({
    is_enabled: z.boolean().nullish().transform((value) => value ?? false),
    max_per_user_per_stream: nullableInteger,
  }).nullish().transform((value) => value ?? { is_enabled: false, max_per_user_per_stream: null }),
  is_paused: z.boolean().nullish().transform((value) => value ?? null),
  is_in_stock: z.boolean().nullish().transform((value) => value ?? null),
  should_redemptions_skip_request_queue: z.boolean().nullish().transform((value) => value ?? null),
}).transform(({ global_cooldown_setting, max_per_stream_setting, max_per_user_per_stream_setting, ...reward }) => ({
  ...reward,
  is_global_cooldown_enabled: global_cooldown_setting.is_enabled,
  global_cooldown_seconds: global_cooldown_setting.is_enabled ? global_cooldown_setting.global_cooldown_seconds : null,
  is_max_per_stream_enabled: max_per_stream_setting.is_enabled,
  max_per_stream: max_per_stream_setting.is_enabled ? max_per_stream_setting.max_per_stream : null,
  is_max_per_user_per_stream_enabled: max_per_user_per_stream_setting.is_enabled,
  max_per_user_per_stream: max_per_user_per_stream_setting.is_enabled
    ? max_per_user_per_stream_setting.max_per_user_per_stream : null,
}));
const rewardsEnvelopeSchema = z.object({ data: z.array(rewardSchema) });
const redemptionSchema = z.object({
  id: z.string().min(1), user_id: z.string().nullish().transform((value) => value ?? ""),
  user_login: z.string().nullish().transform((value) => value ?? ""),
  user_name: z.string().nullish().transform((value) => value ?? ""),
  user_input: z.string().nullish().transform((value) => value ?? ""),
  redeemed_at: z.string().nullish().transform((value) => value ?? ""),
  status: z.enum(["UNFULFILLED", "FULFILLED", "CANCELED"]),
  reward: z.object({ id: z.string().min(1), title: z.string().nullish().transform((value) => value ?? "") }),
});
const redemptionPageSchema = z.object({
  data: z.array(redemptionSchema),
  pagination: z.object({ cursor: z.string().nullish() }).nullish(),
}).transform(({ data, pagination }) => ({ data: { items: data, cursor: pagination?.cursor ?? null } }));
const emptyResponseSchema = z.union([
  z.object({ data: z.array(z.unknown()).optional() }),
  z.null(),
]).transform(() => ({ data: [] as unknown[] }));

const mapHttp = (status: number | null, message: string | null): ChannelPointsHelixReason => {
  if (status === null) return "network";
  if (status >= 200 && status < 300) return "success";
  if (status === 401) return "scope_missing";
  if (status === 403) {
    if (/affiliate|partner/iu.test(message ?? "")) return "not_affiliate";
    return "scope_missing";
  }
  if (status === 409 || /already exists|duplicate|already.*(used|in use)|title.*(used|duplicate)/iu.test(message ?? "")) {
    return "duplicate_title";
  }
  if (status === 400) {
    if (/50|limit|maximum/iu.test(message ?? "")) return "reward_limit";
    return "invalid_input";
  }
  if (status === 429) return "rate_limited";
  return "unknown_status";
};
type TokenFailure<Data> = Exclude<BroadcasterTokenResult<Data>, { kind: "ok" }>;
const mapTokenFailure = <Data>(result: TokenFailure<Data>): ChannelPointsHelixReason => {
  if (result.kind === "http_error") {
    return result.result.reason === "invalid_response" ? "invalid_response" : mapHttp(result.result.status, result.result.message);
  }
  if (result.kind === "request_failed") return "network";
  return result.kind;
};
interface RequestSpec<Data> {
  environment: Env; broadcasterId: string; scope: "channel:read:redemptions" | "channel:manage:redemptions";
  url: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; query?: Readonly<Record<string, string | undefined>>;
  body?: unknown; authorize?: () => Promise<boolean>; schema: z.ZodType<{ data: Data }>; fetcher: typeof fetch;
}
const request = async <Data>(spec: RequestSpec<Data>): Promise<ChannelPointsHelixResult<Data>> => {
  const result = await withBroadcasterToken<{ data: Data }>(
    spec.environment, spec.broadcasterId, [spec.scope],
    (accessToken) => helixRequest({
      url: spec.url, ...(spec.method === undefined ? {} : { method: spec.method }),
      ...(spec.query === undefined ? {} : { query: spec.query }),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      clientId: spec.environment.TWITCH_CLIENT_ID, accessToken, schema: spec.schema, fetcher: spec.fetcher,
    }),
    { fetcher: spec.fetcher, ...(spec.authorize === undefined ? {} : { beforeCall: spec.authorize }) },
  );
  return result.kind === "ok" ? { ok: true, data: result.value.data } : { ok: false, reason: mapTokenFailure(result) };
};

const payloadFromInput = (input: ChannelPointsRewardInput) => ({
  title: input.title, prompt: input.prompt ?? "", cost: input.cost,
  ...(input.backgroundColor === null ? {} : { background_color: input.backgroundColor }),
  is_enabled: input.enabled, is_user_input_required: input.isUserInputRequired,
  should_redemptions_skip_request_queue: false,
  is_global_cooldown_enabled: input.globalCooldownSeconds !== null,
  is_max_per_stream_enabled: input.maxPerStream !== null,
  is_max_per_user_per_stream_enabled: input.maxPerUserPerStream !== null,
  ...(input.globalCooldownSeconds === null ? {} : { global_cooldown_seconds: input.globalCooldownSeconds }),
  ...(input.maxPerStream === null ? {} : { max_per_stream: input.maxPerStream }),
  ...(input.maxPerUserPerStream === null ? {} : { max_per_user_per_stream: input.maxPerUserPerStream }),
});

export const getManageableRewards = (
  environment: Env, broadcasterId: string, authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixCustomReward[]>> => request({
  environment, broadcasterId, scope: "channel:read:redemptions", url: REWARDS_URL,
  query: { broadcaster_id: broadcasterId, only_manageable_rewards: "true" }, schema: rewardsEnvelopeSchema, authorize, fetcher,
});

export const createCustomReward = (
  environment: Env, broadcasterId: string, input: ChannelPointsRewardInput, authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixCustomReward[]>> => request({
  environment, broadcasterId, scope: "channel:manage:redemptions", url: REWARDS_URL, method: "POST",
  query: { broadcaster_id: broadcasterId }, body: payloadFromInput(input), schema: rewardsEnvelopeSchema, authorize, fetcher,
});

export const updateCustomReward = (
  environment: Env, broadcasterId: string, rewardId: string, input: ChannelPointsRewardInput,
  authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixCustomReward[]>> => request({
  environment, broadcasterId, scope: "channel:manage:redemptions", url: REWARDS_URL, method: "PATCH",
  query: { broadcaster_id: broadcasterId, id: rewardId }, body: payloadFromInput(input),
  schema: rewardsEnvelopeSchema, authorize, fetcher,
});

export const deleteCustomReward = (
  environment: Env, broadcasterId: string, rewardId: string, authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<unknown[]>> => request({
  environment, broadcasterId, scope: "channel:manage:redemptions", url: REWARDS_URL, method: "DELETE",
  query: { broadcaster_id: broadcasterId, id: rewardId }, schema: emptyResponseSchema, authorize, fetcher,
});

export const setCustomRewardEnabled = async (
  environment: Env, broadcasterId: string, rewardId: string, enabled: boolean,
  authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixCustomReward[]>> => {
  return request({
    environment, broadcasterId, scope: "channel:manage:redemptions", url: REWARDS_URL, method: "PATCH",
    query: { broadcaster_id: broadcasterId, id: rewardId }, body: { is_enabled: enabled },
    schema: rewardsEnvelopeSchema, authorize, fetcher,
  });
};

export const updateRedemptionStatus = async (
  environment: Env, broadcasterId: string, rewardId: string, redemptionIds: readonly string[],
  status: TwitchRedemptionStatus, authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<unknown[]>> => {
  if (redemptionIds.length < 1 || redemptionIds.length > 50) return { ok: false, reason: "invalid_input" };
  const url = new URL(REDEMPTIONS_URL);
  for (const id of redemptionIds) url.searchParams.append("id", id);
  url.searchParams.set("broadcaster_id", broadcasterId);
  url.searchParams.set("reward_id", rewardId);
  return request({
    environment, broadcasterId, scope: "channel:manage:redemptions", url: url.toString(), method: "PATCH",
    body: { status }, schema: emptyResponseSchema, authorize, fetcher,
  });
};

export const listUnfulfilledRedemptions = async (
  environment: Env, broadcasterId: string, rewardId: string, authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixRedemption[]>> => {
  const result: HelixRedemption[] = [];
  let after: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const current = await request({
      environment, broadcasterId, scope: "channel:read:redemptions", url: REDEMPTIONS_URL,
      query: { broadcaster_id: broadcasterId, reward_id: rewardId, status: "UNFULFILLED", first: "50", after },
      schema: redemptionPageSchema, authorize, fetcher,
    });
    if (!current.ok) return current;
    result.push(...current.data.items);
    const nextCursor = current.data.cursor ?? undefined;
    if (nextCursor === undefined || cursors.has(nextCursor)) return { ok: true, data: result };
    cursors.add(nextCursor);
    after = nextCursor;
  }
  return { ok: true, data: result };
};
