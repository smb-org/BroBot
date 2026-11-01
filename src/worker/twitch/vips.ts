import type { HelixResult } from "../../modules/contract";
import type { BroadcasterTokenResult } from "../auth/broadcaster-token";
import { withBroadcasterToken } from "../auth/broadcaster-token";
import { helixRequest } from "./helix";

const TEMP_VIP_BROADCASTER_SCOPE = "channel:manage:vips";
const TEMP_VIP_HELIX_URL = "https://api.twitch.tv/helix/channels/vips";

export type VipHttpOperation = "add" | "remove" | "get";
type VipHttpReason =
  | "success"
  | "not_vip"
  | "no_slots"
  | "already_vip"
  | "moderator"
  | "community_gate"
  | "rate_limited"
  | "invalid_response"
  | "network"
  | "unknown_status"
  | "not_connected"
  | "token_unavailable"
  | "scope_missing"
  | "revoked"
  | "refresh_failed"
  | "precondition_failed";

export interface VipOutcome {
  reason: VipHttpReason;
  ambiguous: boolean;
}

type VipFailure = { ok: false; reason: string; ambiguous?: boolean };
export type VipActionResult = { ok: true } | VipFailure;
export type VipLookupResult = { ok: true; isVip: boolean } | VipFailure;

/** One endpoint status table shared by add, remove, and filtered VIP lookup. */
export const mapVipHttpStatus = (
  operation: VipHttpOperation,
  status: number | null,
  message: string | null = null,
  transportReason?: string,
): VipOutcome => {
  if (status === null) {
    return {
      reason: transportReason === "timeout" || transportReason === "network_error" ? "network" : "unknown_status",
      ambiguous: true,
    };
  }
  if ((operation === "add" || operation === "remove") && status === 204) return { reason: "success", ambiguous: false };
  if (operation === "get" && status === 200) return { reason: "success", ambiguous: false };
  if (operation === "remove" && status === 404) return { reason: "not_vip", ambiguous: false };
  if (status === 409) return { reason: "no_slots", ambiguous: false };
  if (status === 422) {
    const normalized = (message ?? "").toLowerCase();
    if (operation === "remove" && normalized.includes("not a vip")) {
      return { reason: "not_vip", ambiguous: false };
    }
    return {
      reason: normalized.includes("moderator") || normalized.includes("mod") ? "moderator" : "already_vip",
      ambiguous: false,
    };
  }
  if (status === 425) return { reason: "community_gate", ambiguous: false };
  if (status === 429) return { reason: "rate_limited", ambiguous: false };
  if (status >= 500) return { reason: "unknown_status", ambiguous: true };
  return { reason: "unknown_status", ambiguous: false };
};

type FailedBroadcasterTokenResult<Data> = Exclude<BroadcasterTokenResult<Data>, { kind: "ok" }>;

export const mapVipCallFailure = (
  result: FailedBroadcasterTokenResult<unknown>,
  operation: VipHttpOperation = "add",
): VipActionResult => {
  if (result.kind === "http_error") {
    if (result.result.reason === "invalid_response") return { ok: false, reason: "invalid_response" };
    const outcome = mapVipHttpStatus(operation, result.result.status, result.result.message, result.result.reason);
    if (outcome.reason === "success" || outcome.reason === "not_vip") return { ok: true };
    return { ok: false, reason: outcome.reason, ...(outcome.ambiguous ? { ambiguous: true } : {}) };
  }
  const reason: VipHttpReason = result.kind === "request_failed"
    ? "network"
    : result.kind;
  return {
    ok: false,
    reason,
    ...(operation === "add" && result.kind === "request_failed" ? { ambiguous: true } : {}),
  };
};

const callFailure = <Data>(
  result: FailedBroadcasterTokenResult<Data>,
  operation: VipHttpOperation,
): VipFailure | { ok: true } => {
  if (result.kind === "http_error") {
    if (result.result.reason === "invalid_response") return { ok: false, reason: "invalid_response" };
    const outcome = mapVipHttpStatus(operation, result.result.status, result.result.message, result.result.reason);
    if (outcome.reason === "success" || outcome.reason === "not_vip") return { ok: true };
    return { ok: false, reason: outcome.reason, ...(outcome.ambiguous ? { ambiguous: true } : {}) };
  }
  return mapVipCallFailure(result, operation);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface VipResponse {
  data: readonly { user_id: string }[];
}

const validVipResponse = (value: unknown): value is VipResponse =>
  isRecord(value) && Array.isArray(value.data) && value.data.every((item) =>
    isRecord(item) && typeof item.user_id === "string");

const expectedSuccessStatus = <Data>(result: HelixResult<Data>, expected: number): HelixResult<Data> =>
  result.ok && result.status !== expected
    ? { ok: false, status: result.status, reason: "invalid_response", message: null, body: {} }
    : result;

export const getChannelVip = async (
  environment: Env,
  broadcasterId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<VipLookupResult> => {
  const result = await withBroadcasterToken<VipResponse>(environment, broadcasterId, [TEMP_VIP_BROADCASTER_SCOPE], async (accessToken) => {
    const response = await helixRequest({
      url: TEMP_VIP_HELIX_URL,
      clientId: environment.TWITCH_CLIENT_ID,
      accessToken,
      query: { broadcaster_id: broadcasterId, user_id: userId },
      fetcher,
    });
    const expected = expectedSuccessStatus(response, 200);
    if (expected.ok && !validVipResponse(expected.data)) {
      return { ok: false, status: expected.status, reason: "invalid_response", message: null, body: {} };
    }
    return expected as HelixResult<VipResponse>;
  }, { fetcher });
  if (result.kind !== "ok") {
    const failure = callFailure(result, "get");
    return failure.ok ? { ok: false, reason: "unknown_status" } : failure;
  }
  return { ok: true, isVip: result.value.data.some((vip) => vip.user_id === userId) };
};

const runVipAction = async (
  operation: "add" | "remove",
  environment: Env,
  broadcasterId: string,
  userId: string,
  fetcher: typeof fetch,
): Promise<VipActionResult> => {
  const method = operation === "add" ? "POST" : "DELETE";
  const result = await withBroadcasterToken<null>(environment, broadcasterId, [TEMP_VIP_BROADCASTER_SCOPE], async (accessToken) => {
    const response = await helixRequest<null>({
      url: TEMP_VIP_HELIX_URL,
      method,
      clientId: environment.TWITCH_CLIENT_ID,
      accessToken,
      query: { broadcaster_id: broadcasterId, user_id: userId },
      fetcher,
    });
    return expectedSuccessStatus(response, 204);
  }, { fetcher });
  if (result.kind !== "ok") return callFailure(result, operation);
  return { ok: true };
};

export const addChannelVip = (
  environment: Env,
  broadcasterId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<VipActionResult> => runVipAction("add", environment, broadcasterId, userId, fetcher);

export const removeChannelVip = (
  environment: Env,
  broadcasterId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<VipActionResult> => runVipAction("remove", environment, broadcasterId, userId, fetcher);
