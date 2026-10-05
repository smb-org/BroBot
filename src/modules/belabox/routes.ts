import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { BELABOX_MODULE_ID, BELABOX_STATS_URL_SECRET, type BelaboxTestResult } from "./contracts";
import { getLatestBelaboxSample, prepareBelaboxSampleClear, prepareBelaboxSampleWrite } from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import { validateBelaboxStatsUrl } from "./domain/stats-url";

const statsUrlSchema = z.object({ url: z.string() });
const testSchema = z.object({ url: z.string().optional() });

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const managementDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "belabox_management_denied" }, 403);

export const belaboxRoutes = new Hono<ModuleRouteEnvironment>();

belaboxRoutes.get("/status", async (context) => {
  const channelId = channelIdOf(context);
  const [secretStatus, sample] = await Promise.all([
    context.get("secrets")(channelId).status(BELABOX_STATS_URL_SECRET),
    getLatestBelaboxSample(context.env.DB, channelId),
  ]);
  return context.json({ ...secretStatus, sample });
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
  const usesStoredUrl = parsed.data.url === undefined;
  const input = usesStoredUrl ? await context.get("secrets")(channelId).read(BELABOX_STATS_URL_SECRET) : parsed.data.url;
  if (input === null || input === undefined) {
    return context.json({ ok: false, reason: "not_configured" } satisfies BelaboxTestResult);
  }
  const validation = validateBelaboxStatsUrl(input);
  if (!validation.ok) {
    return context.json({ ok: false, reason: validation.reason } satisfies BelaboxTestResult);
  }

  const result = await fetchRelaySample(
    validation.url,
    validation.publisherKey,
    context.get("externalFetchBudget"),
  );
  if (!result.ok) return context.json({ ok: false, reason: result.reason } satisfies BelaboxTestResult);

  if (usesStoredUrl) {
    const now = new Date().toISOString();
    const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
    try {
      await prepareBelaboxSampleWrite(context.env.DB, channelId, result.sample, authorization).run();
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
