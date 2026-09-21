import { Hono, type Context } from "hono";

import type { ModuleRouteEnvironment } from "../contract";
import { getAdSchedule, type AdScheduleResult, snoozeNextAd, type SnoozeNextAdResult } from "./adapters/ad-schedule";
import { aktualisiereWerbevorwarnungswecker } from "./adapters/vorwarnungswecker";
import { WERBUNG_OPTIONALE_BROADCASTER_SCOPES } from "./contracts";
import type { WerbungZeitplanAntwort } from "./contracts";
import { listeLetzteWerbepausen } from "./repository";

const MANAGE_ADS_SCOPE = WERBUNG_OPTIONALE_BROADCASTER_SCOPES[0];

type WerbeDetail = Readonly<Record<string, string | number | boolean | null>>;

const nowIso = (): string => new Date().toISOString();

const scheduleFailureDiagnostic = (result: AdScheduleResult): {
  code: string;
  detail: Readonly<Record<string, string | number | boolean | null>>;
} => ({
  code: result.reason === "unauthorized" ? "werbung.vorwarnung.scope_fehlt" : "werbung.vorwarnung.zeitplan_fehler",
  detail: { grund: result.reason, ...result.detail },
});

const statusFor = (reason: string | null): 403 | 429 | 502 | 503 => {
  if (reason === "scope_missing" || reason === "unauthorized") return 403;
  if (reason === "rate_limited") return 429;
  if (reason === "network_error" || reason === "app_token_error") return 503;
  return 502;
};

const responseFor = async (
  db: D1Database,
  channelId: string,
  schedule: NonNullable<AdScheduleResult["schedule"]>,
  snoozeScopeVorhanden: boolean,
): Promise<WerbungZeitplanAntwort> => ({
  schedule,
  snoozeScopeVorhanden,
  letzteWerbepausen: await listeLetzteWerbepausen(db, channelId),
});

const log = async (
  context: Context<ModuleRouteEnvironment>,
  channelId: string,
  triggerId: string,
  code: string,
  detail: WerbeDetail,
): Promise<void> => {
  await context.get("writeModuleDiagnostics")(
    context.env.DB,
    channelId,
    "werbung",
    triggerId,
    context.get("actor").userId,
    [{ code, detail }],
    nowIso(),
  );
};

const snoozeOutcome = (result: SnoozeNextAdResult): WerbeDetail => ({
  ausgang: result.snoozed ? "erfolgreich" : "fehlgeschlagen",
  grund: result.reason,
  ...result.detail,
});

export const werbungRoutes = new Hono<ModuleRouteEnvironment>();

werbungRoutes.get("/zeitplan", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const result = await getAdSchedule(context.env, channelId, now, context.get("getAppAccessToken"), fetch);
  if (!result.fetched || result.schedule === null) {
    const diagnostic = scheduleFailureDiagnostic(result);
    await log(context, channelId, `werbung-zeitplan:${crypto.randomUUID()}`, diagnostic.code, diagnostic.detail);
    return context.json({
      error: "Der Werbezeitplan konnte nicht gelesen werden.",
      reason: result.reason,
      detail: result.detail,
    }, statusFor(result.reason));
  }

  await aktualisiereWerbevorwarnungswecker(
    context.env,
    channelId,
    result.schedule,
    context.get("broadcasterHasScope"),
  );
  const snoozeScopeVorhanden = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  return context.json(await responseFor(context.env.DB, channelId, result.schedule, snoozeScopeVorhanden));
});

werbungRoutes.post("/snooze", async (context) => {
  const channelId = context.req.param("channelId") ?? "";
  const now = nowIso();
  const triggerId = `werbung-snooze:${crypto.randomUUID()}`;
  const scopeVorhanden = await context.get("broadcasterHasScope")(context.env.DB, channelId, MANAGE_ADS_SCOPE);
  const result: SnoozeNextAdResult = scopeVorhanden
    ? await snoozeNextAd(context.env, channelId, now, context.get("getAppAccessToken"), fetch)
    : {
      snoozed: false,
      reason: "scope_missing",
      detail: { scope: MANAGE_ADS_SCOPE, status: null, message: null },
      schedule: null,
    };
  await log(context, channelId, triggerId, "werbung.snooze", snoozeOutcome(result));

  if (!result.snoozed || result.schedule === null) {
    return context.json({
      error: "Die nächste Werbepause konnte nicht verschoben werden.",
      reason: result.reason,
      detail: result.detail,
    }, statusFor(result.reason));
  }

  await aktualisiereWerbevorwarnungswecker(
    context.env,
    channelId,
    result.schedule,
    context.get("broadcasterHasScope"),
  );
  return context.json(await responseFor(context.env.DB, channelId, result.schedule, scopeVorhanden));
});
