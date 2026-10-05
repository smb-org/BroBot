import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { AuthorizeModuleMutation, ModuleMutationActor, ModuleRouteEnvironment } from "../contract";
import { BELABOX_MODULE_ID, BELABOX_STATS_URL_SECRET, type BelaboxTestResult } from "./contracts";
import { getBelaboxStatus, prepareBelaboxSampleClear, prepareBelaboxSampleWrite } from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import { validateBelaboxStatsUrl } from "./domain/stats-url";
import { belaboxSettingsForChannel, currentBelaboxSample } from "./service";

const statsUrlSchema = z.object({ url: z.string() });
const testSchema = z.object({ url: z.string().optional() });

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const managementDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "belabox_management_denied" }, 403);

const hasManagementAuthorization = async (
  db: D1Database,
  channelId: string,
  actor: ModuleMutationActor,
  authorizeManagementMutation: AuthorizeModuleMutation,
): Promise<boolean> => {
  const authorization = authorizeManagementMutation(channelId, actor, new Date().toISOString());
  const row = await db.prepare(`SELECT 1 AS authorized WHERE 1 = 1 ${authorization.sql}`)
    .bind(...authorization.values).first<{ authorized: number }>();
  return row !== null;
};

export const belaboxRoutes = new Hono<ModuleRouteEnvironment>();

belaboxRoutes.get("/status", async (context) => {
  const channelId = channelIdOf(context);
  const secrets = context.get("secrets")(channelId);
  const [secretStatus, moduleState] = await Promise.all([
    secrets.status(BELABOX_STATS_URL_SECRET),
    belaboxSettingsForChannel(context.env.DB, channelId),
  ]);
  if (moduleState?.enabled === true && moduleState.settings.mode === "on_demand" && secretStatus.configured) {
    await currentBelaboxSample({
      DB: context.env.DB,
      channelId,
      secrets,
      externalFetchBudget: context.get("externalFetchBudget"),
      writeDiagnostics: (triggerId, diagnostics, now) => context.get("writeModuleDiagnostics")(
        context.env.DB,
        channelId,
        BELABOX_MODULE_ID,
        triggerId,
        null,
        diagnostics,
        now,
      ),
    });
  }
  const status = await getBelaboxStatus(context.env.DB, channelId);
  return context.json({
    ...secretStatus,
    sample: status?.sample ?? null,
    errorCode: status?.errorCode ?? null,
    polling: status?.polling ?? false,
    streamId: status?.streamId ?? null,
    belaboxStreamId: status?.belaboxStreamId ?? null,
  });
});

belaboxRoutes.put("/stats-url", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const parsed = statsUrlSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "belabox_stats_url_invalid" }, 400);
  const validation = validateBelaboxStatsUrl(parsed.data.url);
  if (!validation.ok) return context.json({ error: `belabox_stats_url_${validation.reason}` }, 400);

  const channelId = channelIdOf(context);
  const now = new Date().toISOString();
  const actor = context.get("actor");
  const authorization = context.get("authorizeManagementMutation")(channelId, actor, now);
  try {
    const write = await context.get("secrets")(channelId).prepareWrite(
      BELABOX_STATS_URL_SECRET,
      validation.url.href,
      actor,
      now,
    );
    const clearSample = prepareBelaboxSampleClear(context.env.DB, channelId, authorization);
    const audit = context.get("prepareModuleAudit")({
      channelId,
      moduleId: BELABOX_MODULE_ID,
      action: "module.secret.replaced",
      before: null,
      after: { statsUrl: "replaced" },
    }, now);
    const result = await context.env.DB.batch([write, audit, clearSample]);
    if ((result[0]?.meta.changes ?? 0) === 0) return managementDenied(context);
    await context.get("runModuleAlarm")(channelId, BELABOX_MODULE_ID, "poll", "poll");
    return context.json({ configured: true });
  } catch {
    return context.json({ error: "belabox_stats_url_save_failed" }, 500);
  }
});

belaboxRoutes.delete("/stats-url", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const channelId = channelIdOf(context);
  const secretAccess = context.get("secrets")(channelId);
  const secretStatus = await secretAccess.status(BELABOX_STATS_URL_SECRET);
  if (!secretStatus.configured) return context.json({ configured: false });

  const now = new Date().toISOString();
  const actor = context.get("actor");
  const authorization = context.get("authorizeManagementMutation")(channelId, actor, now);
  try {
    const remove = secretAccess.prepareDelete(BELABOX_STATS_URL_SECRET, actor, now);
    const clearSample = prepareBelaboxSampleClear(context.env.DB, channelId, authorization);
    const audit = context.get("prepareModuleAudit")({
      channelId,
      moduleId: BELABOX_MODULE_ID,
      action: "module.secret.removed",
      before: { statsUrl: "configured" },
      after: { statsUrl: "removed" },
    }, now);
    const result = await context.env.DB.batch([remove, audit, clearSample]);
    if ((result[0]?.meta.changes ?? 0) === 0) return managementDenied(context);
    await context.get("runModuleAlarm")(channelId, BELABOX_MODULE_ID, "poll", "poll");
    return context.json({ configured: false });
  } catch {
    return context.json({ error: "belabox_stats_url_remove_failed" }, 500);
  }
});

belaboxRoutes.post("/test", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const parsed = testSchema.safeParse(await context.req.json().catch(() => ({})));
  if (!parsed.success) return context.json({ error: "belabox_test_invalid" }, 400);

  const channelId = channelIdOf(context);
  const actor = context.get("actor");
  const authorizeManagementMutation = context.get("authorizeManagementMutation");
  if (!await hasManagementAuthorization(context.env.DB, channelId, actor, authorizeManagementMutation)) {
    return managementDenied(context);
  }

  const usesStoredUrl = parsed.data.url === undefined;
  const storedSecret = usesStoredUrl
    ? await context.get("secrets")(channelId).readWithVersion(BELABOX_STATS_URL_SECRET)
    : null;
  const input = usesStoredUrl ? storedSecret?.value : parsed.data.url;
  if (input === undefined) {
    return context.json({ ok: false, reason: "not_configured" } satisfies BelaboxTestResult);
  }
  const validation = validateBelaboxStatsUrl(input);
  if (!validation.ok) {
    return context.json({ ok: false, reason: validation.reason } satisfies BelaboxTestResult);
  }

  if (!await hasManagementAuthorization(context.env.DB, channelId, actor, authorizeManagementMutation)) {
    return managementDenied(context);
  }

  const result = await fetchRelaySample(
    validation.url,
    validation.publisherKey,
    context.get("externalFetchBudget"),
  );
  if (!result.ok) return context.json({ ok: false, reason: result.reason } satisfies BelaboxTestResult);

  if (usesStoredUrl) {
    const now = new Date().toISOString();
    const authorization = authorizeManagementMutation(channelId, actor, now);
    try {
      if (storedSecret !== null) {
        await prepareBelaboxSampleWrite(context.env.DB, channelId, result.sample, storedSecret.version, authorization).run();
      }
    } catch {
      // The test result remains useful when the optional latest-sample write fails.
    }
  }

  return context.json({
    ok: true,
    connected: result.sample.connected,
    bitrateKbps: result.sample.bitrateKbps,
  } satisfies BelaboxTestResult);
});
