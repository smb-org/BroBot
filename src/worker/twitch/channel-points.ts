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
  is_global_cooldown_enabled: z.boolean().nullish().transform((value) => value ?? false),
  global_cooldown_seconds: nullableInteger, max_per_stream: nullableInteger, max_per_user_per_stream: nullableInteger,
  is_max_per_stream_enabled: z.boolean().nullish().transform((value) => value ?? false),
  is_max_per_user_per_stream_enabled: z.boolean().nullish().transform((value) => value ?? false),
  is_paused: z.boolean().nullish().transform((value) => value ?? null),
  is_in_stock: z.boolean().nullish().transform((value) => value ?? null),
  should_redemptions_skip_request_queue: z.boolean().nullish().transform((value) => value ?? null),
}).transform((reward) => ({
  ...reward,
  global_cooldown_seconds: reward.is_global_cooldown_enabled ? reward.global_cooldown_seconds : null,
  max_per_stream: reward.is_max_per_stream_enabled ? reward.max_per_stream : null,
  max_per_user_per_stream: reward.is_max_per_user_per_stream_enabled ? reward.max_per_user_per_stream : null,
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
  body: { broadcaster_id: broadcasterId, ...payloadFromInput(input) }, schema: rewardsEnvelopeSchema, authorize, fetcher,
});

export const updateCustomReward = (
  environment: Env, broadcasterId: string, rewardId: string, input: ChannelPointsRewardInput,
  authorize: () => Promise<boolean>, fetcher: typeof fetch = fetch,
): Promise<ChannelPointsHelixResult<HelixCustomReward[]>> => request({
  environment, broadcasterId, scope: "channel:manage:redemptions", url: REWARDS_URL, method: "PUT",
  body: { broadcaster_id: broadcasterId, id: rewardId, ...payloadFromInput(input) },
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
  const current = await request({
    environment, broadcasterId, scope: "channel:read:redemptions", url: REWARDS_URL,
    query: { broadcaster_id: broadcasterId, id: rewardId }, schema: rewardsEnvelopeSchema, authorize, fetcher,
  });
  if (!current.ok) return current;
  const reward = current.data[0];
  if (reward === undefined) return { ok: false, reason: "invalid_response" };
  const input: ChannelPointsRewardInput = {
    title: reward.title, prompt: reward.prompt, cost: reward.cost, backgroundColor: reward.background_color,
    isUserInputRequired: reward.is_user_input_required, globalCooldownSeconds: reward.global_cooldown_seconds,
    maxPerStream: reward.max_per_stream, maxPerUserPerStream: reward.max_per_user_per_stream,
    actionModuleId: "channel_points", actionId: "chat-message", actionConfig: {}, mode: "auto", enabled,
  };
  return updateCustomReward(environment, broadcasterId, rewardId, input, authorize, fetcher);
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
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
    const current = await request({
      environment, broadcasterId, scope: "channel:read:redemptions", url: REDEMPTIONS_URL,
      query: { broadcaster_id: broadcasterId, reward_id: rewardId, status: "UNFULFILLED", first: "50", cursor },
      schema: redemptionPageSchema, authorize, fetcher,
    });
    if (!current.ok) return current;
    result.push(...current.data.items);
    const nextCursor = current.data.cursor ?? undefined;
    if (nextCursor === undefined || cursors.has(nextCursor)) return { ok: true, data: result };
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { ok: true, data: result };
};
