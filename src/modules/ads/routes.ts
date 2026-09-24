import { Hono, type Context } from "hono";

import type { EventCode } from "../../contracts/values";
import { apiErrorDetail, type ModuleRouteEnvironment } from "../contract";
import { snoozeNextAd, type SnoozeNextAdResult } from "./adapters/ad-schedule";
import type { AdsSchedule } from "./contracts";
import { COMMERCIAL_LENGTHS, startCommercial, type CommercialLength, type CommercialResult } from "./adapters/commercial";
import { ADS_OPTIONAL_BROADCASTER_SCOPES } from "./contracts";
import { listLastAdBreaks } from "./repository";

const MANAGE_ADS_SCOPE = ADS_OPTIONAL_BROADCASTER_SCOPES[0];
const COMMERCIAL_SCOPE = "channel:edit:commercial";

type AdDetail = Readonly<Record<string, string | number | boolean | null>>;

const nowIso = (): string => new Date().toISOString();

const statusFor = (reason: string | null): 403 | 429 | 502 | 503 => {
  if (reason === "scope_missing" || reason === "unauthorized") return 403;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable") return 503;
  return 502;
};

const SCHEDULE_CACHE_TTL_MS = 60_000;
interface ScheduleCacheValue { schedule: AdsSchedule; asOf: string }

const scheduleStatusFor = (reason: string | null): 403 | 429 | 502 | 503 =>
  reason === "unauthorized" || reason === "scope_missing" ? 403
    : reason === "rate_limited" ? 429
      : reason === "network_error" || reason === "timeout" || reason === "app_token_unavailable" ? 503
        : 502;

const log = async (
  context: Context<ModuleRouteEnvironment>,
  channelId: string,
  triggerId: string,
  code: EventCode,
  detail: AdDetail,
): Promise<void> => {
  await context.get("writeModuleDiagnostics")(
    context.env.DB,
    channelId,
    "ads",
    triggerId,
    context.get("actor").userId,
    [{ code, detail }],
    nowIso(),
  );
};

const snoozeOutcome = (result: SnoozeNextAdResult): AdDetail => ({
  outcome: result.snoozed ? "success" : "failed",
  reason: result.reason,
  ...result.detail,
});

const commercialOutcome = (result: CommercialResult): AdDetail => ({
  outcome: result.started ? "success" : "failed",
  reason: result.reason,
  ...result.detail,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCommercialLength = (value: unknown): value is CommercialLength =>
  typeof value === "number" && (COMMERCIAL_LENGTHS as readonly number[]).includes(value);

const commercialStatusFor = (reason: CommercialResult["reason"]): 400 | 403 | 429 | 502 | 503 => {
  if (reason === "stream_offline") return 400;
  if (reason === "scope_missing") return 403;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable") return 503;
  return 502;
};

export const adsRoutes = new Hono<ModuleRouteEnvironment>();

adsRoutes.get("/schedule", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  const [cached, details] = await Promise.all([
    context.get("measureServerTiming")("do", () => object.getCachedAdSchedule()),
    context.get("measureServerTiming")("d1", () => Promise.all([
      listLastAdBreaks(context.env.DB, channelId),
      context.get("broadcasterScopesForChannel")(context.env.DB, channelId),
    ])),
  ]);
  const fresh = cached !== null && Date.now() - Date.parse(cached.asOf) < SCHEDULE_CACHE_TTL_MS;
  let current: ScheduleCacheValue | null = cached === null ? null : { schedule: cached.schedule, asOf: cached.asOf };
  if (cached !== null) {
    await context.get("measureServerTiming")("do", () => object.reconcileCachedAdPrewarning(details[1]));
  }
  const retryAfter = await context.get("measureServerTiming")("do", () => object.getTwitchRateLimitRetryAfter());
  if (!fresh && cached !== null && retryAfter === null) {
    context.get("scheduleBackgroundWork")(object.refreshAdSchedule(details[1]).then((refresh) => {
      if (refresh.reason !== null) console.warn("Background ad schedule refresh did not complete.", refresh.reason);
    }).catch((error: unknown) => {
      console.warn("Background ad schedule refresh failed.", error);
    }));
  } else if (!fresh && cached === null && retryAfter === null) {
    const refresh = await context.get("measureServerTiming")("do", () => object.refreshAdSchedule(details[1]));
    context.get("recordServerTiming")("d1", refresh.d1Ms);
    context.get("recordServerTiming")("helix", refresh.helixMs);
    current = refresh.cache === null ? null : { schedule: refresh.cache.schedule, asOf: refresh.cache.asOf };
    if (current === null) {
      return context.json({
        error: "ad_schedule_read_failed",
        reason: refresh.reason,
        detail: apiErrorDetail(refresh.detail),
      }, scheduleStatusFor(refresh.reason));
    }
  } else if (!fresh && cached === null && retryAfter !== null) {
    return context.json({
      error: "ad_schedule_read_failed",
      reason: "rate_limited",
      detail: { retryAfter },
    }, scheduleStatusFor("rate_limited"));
  }

  const schedule = current?.schedule;
  if (schedule === undefined || current === null) return context.json({ error: "ad_schedule_read_failed" }, 503);
  const [recentAdBreaks, grantedScopes] = details;
  const snoozeScopeAvailable = grantedScopes.includes(MANAGE_ADS_SCOPE);
  return context.json({ schedule, asOf: current.asOf, snoozeScopeAvailable, recentAdBreaks });
});

adsRoutes.post("/snooze", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `werbung-snooze:${crypto.randomUUID()}`;
  const scopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  const result: SnoozeNextAdResult = scopeAvailable
    ? await snoozeNextAd(
      context.env,
      channelId,
      now,
      context.get("getAppAccessToken"),
      context.get("helixRequest"),
      fetch,
    )
    : {
      snoozed: false,
      reason: "scope_missing",
      detail: { scope: MANAGE_ADS_SCOPE, status: null, message: null },
      schedule: null,
    };
  await log(context, channelId, triggerId, "ads.snooze", snoozeOutcome(result));

  const schedule = result.schedule;
  if (!result.snoozed || schedule === null) {
    return context.json({
      error: "ad_snooze_failed",
      reason: result.reason,
      detail: apiErrorDetail(result.detail),
    }, statusFor(result.reason));
  }

  const asOf = nowIso();
  const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  await context.get("measureServerTiming")("do", () => object.storeAdSchedule(schedule, asOf));
  const recentAdBreaks = await context.get("measureServerTiming")("d1", () => listLastAdBreaks(context.env.DB, channelId));
  return context.json({ schedule, asOf, snoozeScopeAvailable: scopeAvailable, recentAdBreaks });
});

/**
 * Immediate action, open to any channel member (0006's "Betrieblich" tier):
 * running a commercial doesn't reconfigure the channel, so an operator may
 * trigger it the same as ads snooze above, which has never gated on role.
 */
adsRoutes.post("/commercial", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `commercial:${crypto.randomUUID()}`;
  const body: unknown = await context.req.json().catch(() => null);
  const length = isRecord(body) ? body.length : undefined;
  if (!isCommercialLength(length)) return context.json({ error: "commercial_length_invalid" }, 400);

  const scopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, COMMERCIAL_SCOPE);
  const result: CommercialResult = scopeAvailable
    ? await startCommercial(
      context.env,
      channelId,
      length,
      now,
      context.get("getAppAccessToken"),
      context.get("helixRequest"),
      fetch,
    )
    : {
      started: false,
      reason: "scope_missing",
      detail: { scope: COMMERCIAL_SCOPE, status: null, message: null },
      length: null,
      message: null,
      retryAfter: null,
    };

  if (!result.started) {
    await log(context, channelId, triggerId, "ads.commercial.failed", commercialOutcome(result));
    return context.json({
      error: result.reason === "stream_offline" ? "commercial_stream_offline" : "commercial_start_failed",
      reason: result.reason,
      detail: apiErrorDetail(result.detail),
    }, commercialStatusFor(result.reason));
  }

  await context.get("writeModuleAudit")({
    channelId,
    moduleId: "ads",
    action: "ads.commercial_started",
    before: null,
    after: { length: result.length ?? length, retryAfter: result.retryAfter },
  }, now);

  return context.json({ length: result.length, message: result.message, retryAfter: result.retryAfter });
});
