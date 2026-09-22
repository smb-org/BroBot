import { Hono, type Context } from "hono";

import type { EventCode } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { getAdSchedule, type AdScheduleResult, snoozeNextAd, type SnoozeNextAdResult } from "./adapters/ad-schedule";
import { refreshAdPrewarningAlarm } from "./adapters/prewarning-alarm";
import { ADS_OPTIONAL_BROADCASTER_SCOPES } from "./contracts";
import type { AdsScheduleResponse } from "./contracts";
import { listLastAdBreaks } from "./repository";

const MANAGE_ADS_SCOPE = ADS_OPTIONAL_BROADCASTER_SCOPES[0];

type AdDetail = Readonly<Record<string, string | number | boolean | null>>;

const nowIso = (): string => new Date().toISOString();

const scheduleFailureDiagnostic = (result: AdScheduleResult): {
  code: EventCode;
  detail: Readonly<Record<string, string | number | boolean | null>>;
} => ({
  code: result.reason === "unauthorized" ? "ads.prewarning.scope_missing" : "ads.prewarning.schedule_error",
  detail: { reason: result.reason, ...result.detail },
});

const statusFor = (reason: string | null): 403 | 429 | 502 | 503 => {
  if (reason === "scope_missing" || reason === "unauthorized") return 403;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_unavailable") return 503;
  return 502;
};

const responseFor = async (
  db: D1Database,
  channelId: string,
  schedule: NonNullable<AdScheduleResult["schedule"]>,
  snoozeScopeAvailable: boolean,
): Promise<AdsScheduleResponse> => ({
  schedule,
  snoozeScopeAvailable,
  recentAdBreaks: await listLastAdBreaks(db, channelId),
});

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

export const adsRoutes = new Hono<ModuleRouteEnvironment>();

adsRoutes.get("/schedule", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const result = await getAdSchedule(context.env, channelId, now, context.get("getAppAccessToken"), fetch);
  if (!result.fetched || result.schedule === null) {
    const diagnostic = scheduleFailureDiagnostic(result);
    await log(context, channelId, `werbung-zeitplan:${crypto.randomUUID()}`, diagnostic.code, diagnostic.detail);
    return context.json({
      error: "ad_schedule_read_failed",
      reason: result.reason,
      detail: result.detail,
    }, statusFor(result.reason));
  }

  await refreshAdPrewarningAlarm(
    context.env,
    channelId,
    result.schedule,
    context.get("broadcasterHasScope"),
  );
  const snoozeScopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  return context.json(await responseFor(context.env.DB, channelId, result.schedule, snoozeScopeAvailable));
});

adsRoutes.post("/snooze", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `werbung-snooze:${crypto.randomUUID()}`;
  const scopeAvailable = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  const result: SnoozeNextAdResult = scopeAvailable
    ? await snoozeNextAd(context.env, channelId, now, context.get("getAppAccessToken"), fetch)
    : {
      snoozed: false,
      reason: "scope_missing",
      detail: { scope: MANAGE_ADS_SCOPE, status: null, message: null },
      schedule: null,
    };
  await log(context, channelId, triggerId, "ads.snooze", snoozeOutcome(result));

  if (!result.snoozed || result.schedule === null) {
    return context.json({
      error: "ad_snooze_failed",
      reason: result.reason,
      detail: result.detail,
    }, statusFor(result.reason));
  }

  await refreshAdPrewarningAlarm(
    context.env,
    channelId,
    result.schedule,
    context.get("broadcasterHasScope"),
  );
  return context.json(await responseFor(context.env.DB, channelId, result.schedule, scopeAvailable));
});
