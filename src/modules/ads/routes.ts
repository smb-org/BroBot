import { Hono, type Context } from "hono";

import { canManage, type EventCode } from "../../contracts/values";
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
  if (reason === "scope_missing" || reason === "unauthorized" || reason === "management_unauthorized") return 403;
  if (reason === "rate_limited" || reason === "snoozes_exhausted") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable") return 503;
  return 502;
};

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

const hasManagementAuthorization = async (
  context: Context<ModuleRouteEnvironment>,
  channelId: string,
): Promise<boolean> => {
  const authorization = context.get("authorizeManagementMutation")(
    channelId,
    context.get("actor"),
    nowIso(),
  );
  const row = await context.env.DB.prepare(`SELECT 1 AS authorized WHERE 1 = 1 ${authorization.sql}`)
    .bind(...authorization.values)
    .first<{ authorized: number }>();
  return row !== null;
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

const previousCommercialCooldownUntil = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<number | null> => {
  const row = await db.prepare(
    `SELECT created_at, after_json
       FROM audit_log
      WHERE channel_id = ?
        AND module_id = 'ads'
        AND action = 'ads.commercial_started'
      ORDER BY created_at DESC
      LIMIT 1`,
  ).bind(channelId).first<{ created_at: string; after_json: string }>();
  if (row === null) return null;

  const startedAt = Date.parse(row.created_at);
  if (!Number.isFinite(startedAt)) return null;
  let after: unknown;
  try {
    after = JSON.parse(row.after_json) as unknown;
  } catch {
    return null;
  }
  const retryAfter = isRecord(after) ? after.retryAfter : null;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= 0) return null;

  const until = startedAt + retryAfter * 1000;
  return until > Date.parse(now) ? until : null;
};

const isCommercialLength = (value: unknown): value is CommercialLength =>
  typeof value === "number" && (COMMERCIAL_LENGTHS as readonly number[]).includes(value);

const commercialStatusFor = (reason: CommercialResult["reason"] | "commercial_cooldown"): 400 | 401 | 403 | 429 | 502 | 503 => {
  if (reason === "stream_offline") return 400;
  if (reason === "commercial_cooldown") return 400;
  if (reason === "scope_missing") return 403;
  if (reason === "token_invalid") return 401;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable") return 503;
  return 502;
};

const isCommercialCooldownMessage = (detail: CommercialResult["detail"]): boolean => {
  const message = detail.twitchMessage;
  return typeof message === "string" && /(?:commercial|ad break).{0,100}cooldown|cooldown.{0,100}(?:commercial|ad break)/i.test(message);
};

export const adsRoutes = new Hono<ModuleRouteEnvironment>();

adsRoutes.get("/schedule", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  const [cached, details, retryAfter] = await Promise.all([
    context.get("measureServerTiming")("do", () => object.getCachedAdSchedule()),
    context.get("measureServerTiming")("d1", () => Promise.all([
      listLastAdBreaks(context.env.DB, channelId),
      context.get("broadcasterScopesForChannel")(context.env.DB, channelId),
    ])),
    context.get("measureServerTiming")("do", () => object.getTwitchRateLimitRetryAfter()),
  ]);
  const current: ScheduleCacheValue | null = cached === null ? null : { schedule: cached.schedule, asOf: cached.asOf };
  if (current === null && retryAfter !== null) {
    return context.json({
      error: "ad_schedule_read_failed",
      reason: "rate_limited",
      detail: { retryAfter },
    }, scheduleStatusFor("rate_limited"));
  }
  if (current === null) return context.json({ error: "ad_schedule_read_failed", reason: "cache_empty" }, 503);
  const [recentAdBreaks, grantedScopes] = details;
  const snoozeScopeAvailable = grantedScopes.includes(MANAGE_ADS_SCOPE);
  return context.json({ schedule: current.schedule, asOf: current.asOf, snoozeScopeAvailable, recentAdBreaks });
});

adsRoutes.post("/schedule/refresh", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "ad_schedule_refresh_denied" }, 403);
  const channelId = context.req.param("channelId") ?? "";
  const [recentAdBreaks, grantedScopes] = await Promise.all([
    listLastAdBreaks(context.env.DB, channelId),
    context.get("broadcasterScopesForChannel")(context.env.DB, channelId),
  ]);
  const object = context.env.CHANNEL.get(context.env.CHANNEL.idFromName(channelId));
  const refresh = await context.get("measureServerTiming")("do", () => object.refreshAdSchedule(grantedScopes));
  context.get("recordServerTiming")("d1", refresh.d1Ms);
  context.get("recordServerTiming")("helix", refresh.helixMs);
  const current = refresh.cache === null ? null : { schedule: refresh.cache.schedule, asOf: refresh.cache.asOf };
  if (refresh.reason !== null || current === null) {
    return context.json({
      error: "ad_schedule_refresh_failed",
      reason: refresh.reason,
      detail: apiErrorDetail(refresh.detail),
    }, scheduleStatusFor(refresh.reason));
  }
  return context.json({
    schedule: current.schedule,
    asOf: current.asOf,
    snoozeScopeAvailable: grantedScopes.includes(MANAGE_ADS_SCOPE),
    recentAdBreaks,
  });
});

adsRoutes.post("/snooze", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "ad_snooze_denied" }, 403);
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `werbung-snooze:${crypto.randomUUID()}`;
  const scopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  if (!await hasManagementAuthorization(context, channelId)) {
    return context.json({ error: "ad_snooze_denied" }, 403);
  }
  const result: SnoozeNextAdResult = scopeAvailable
    ? await snoozeNextAd(
      context.env,
      channelId,
      now,
      context.get("getAppAccessToken"),
      () => hasManagementAuthorization(context, channelId),
      context.get("helixRequest"),
      fetch,
    )
    : {
      snoozed: false,
      reason: "scope_missing",
      detail: { scope: MANAGE_ADS_SCOPE, status: null, message: null },
      schedule: null,
    };
  if (result.reason === "management_unauthorized") return context.json({ error: "ad_snooze_denied" }, 403);
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

adsRoutes.post("/commercial", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "commercial_start_denied" }, 403);
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `commercial:${crypto.randomUUID()}`;
  const body: unknown = await context.req.json().catch(() => null);
  const length = isRecord(body) ? body.length : undefined;
  if (!isCommercialLength(length)) return context.json({ error: "commercial_length_invalid" }, 400);

  const scopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, COMMERCIAL_SCOPE);
  if (!await hasManagementAuthorization(context, channelId)) {
    return context.json({ error: "commercial_start_denied" }, 403);
  }
  const result: CommercialResult = scopeAvailable
    ? await startCommercial(
      context.env,
      channelId,
      length,
      now,
      context.get("getAppAccessToken"),
      () => hasManagementAuthorization(context, channelId),
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
      rateLimitRemaining: null,
    };

  if (!result.started) {
    if (result.reason === "unauthorized") return context.json({ error: "commercial_start_denied" }, 403);
    await log(context, channelId, triggerId, "ads.commercial.failed", commercialOutcome(result));
    const cooldownMessage = isCommercialCooldownMessage(result.detail);
    const cooldownStatus = result.detail.status === 400 || result.detail.status === 429;
    const canHaveCommercialCooldown = cooldownStatus && (cooldownMessage ||
      (result.detail.status === 429 && result.rateLimitRemaining !== null && result.rateLimitRemaining > 0));
    const previousCooldownUntil = canHaveCommercialCooldown
      ? await previousCommercialCooldownUntil(context.env.DB, channelId, now)
      : null;
    const commercialCooldown = cooldownMessage && cooldownStatus || result.detail.status === 429 &&
      result.rateLimitRemaining !== null && result.rateLimitRemaining > 0 && previousCooldownUntil !== null;
    const cooldownUntil = commercialCooldown ? previousCooldownUntil : null;
    const reason = commercialCooldown ? "commercial_cooldown" : result.reason;
    const detail: Record<string, string | number | boolean | null> = { ...apiErrorDetail(result.detail) };
    if (commercialCooldown) delete detail.retryAfter;
    return context.json({
      error: reason === "stream_offline" ? "commercial_stream_offline" : "commercial_start_failed",
      reason,
      detail: {
        ...detail,
        ...(cooldownUntil === null ? {} : { commercialCooldownUntil: cooldownUntil }),
      },
    }, reason === "commercial_cooldown" && result.detail.status === 429
      ? 429
      : commercialStatusFor(reason));
  }

  await context.get("writeModuleAudit")({
    channelId,
    moduleId: "ads",
    action: "ads.commercial_started",
    before: null,
    after: { length: result.length ?? length, retryAfter: result.retryAfter },
  }, nowIso());

  return context.json({ length: result.length, message: result.message, retryAfter: result.retryAfter });
});
