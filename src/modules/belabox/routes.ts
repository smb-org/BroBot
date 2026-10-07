import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { AuthorizeModuleMutation, ModuleMutationActor, ModuleRouteEnvironment } from "../contract";
import {
  BELABOX_MODULE_ID,
  BELABOX_ENSURE_POLL_HANDLER,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_STATS_URL_SECRET,
  type BelaboxTestResult,
} from "./contracts";
import {
  getBelaboxLiveHistory,
  getBelaboxStatus,
  getBelaboxStreamHistory,
  listBelaboxStreams,
  prepareBelaboxSampleClear,
  prepareBelaboxSampleWrite,
} from "./adapters/d1";
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

const ensurePollingBestEffort = async (
  runModuleAlarm: ModuleRouteEnvironment["Variables"]["runModuleAlarm"],
  writeModuleDiagnostics: ModuleRouteEnvironment["Variables"]["writeModuleDiagnostics"],
  db: D1Database,
  channelId: string,
): Promise<void> => {
  try {
    await runModuleAlarm(channelId, BELABOX_MODULE_ID, BELABOX_ENSURE_POLL_HANDLER, BELABOX_POLL_ALARM_KEY);
  } catch {
    try {
      await writeModuleDiagnostics(
        db,
        channelId,
        BELABOX_MODULE_ID,
        "belabox:polling_ensure",
        null,
        [{ code: "belabox.polling_ensure_failed" }],
        new Date().toISOString(),
      );
    } catch {
      // Ensure diagnostics never change the committed mutation response.
    }
  }
};

export const belaboxRoutes = new Hono<ModuleRouteEnvironment>();

belaboxRoutes.get("/status", async (context) => {
  const channelId = channelIdOf(context);
  const secrets = context.get("secrets")(channelId);
  const [secretStatus, moduleState, streamState] = await Promise.all([
    secrets.status(BELABOX_STATS_URL_SECRET),
    belaboxSettingsForChannel(context.env.DB, channelId),
    context.env.DB.prepare(
      "SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?",
    ).bind(channelId).first<{ state: string; stream_id: string | null }>(),
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
  const pollingDesired = moduleState?.enabled === true && moduleState.settings.mode === "interval" &&
    secretStatus.configured && streamState?.state === "online";
  const classifiedBelaboxStream = moduleState?.enabled === true && moduleState.settings.mode === "interval" &&
    moduleState.settings.alertsEnabled && streamState?.state === "online" && streamState.stream_id !== null &&
    status?.streamId === streamState.stream_id && status.belaboxStreamId === streamState.stream_id;
  const alertPhase = classifiedBelaboxStream && status.alertState.phase !== "ok" && status.alertState.kind !== null
    ? { phase: status.alertState.phase, kind: status.alertState.kind, bitrateKbps: status.sample?.bitrateKbps ?? null }
    : null;
  return context.json({
    ...secretStatus,
    mode: moduleState?.settings.mode ?? null,
    sample: status?.sample ?? null,
    errorCode: status?.errorCode ?? null,
    polling: status?.polling ?? false,
    pollingDesired,
    streamId: status?.streamId ?? null,
    belaboxStreamId: status?.belaboxStreamId ?? null,
    alertNotice: alertPhase,
    fetchFailureNotice: classifiedBelaboxStream && status.fetchPhase.failing,
    intervalSeconds: moduleState?.settings.intervalSeconds ?? 15,
  });
});

belaboxRoutes.get("/history", async (context) => {
  const channelId = channelIdOf(context);
  const range = context.req.query("range");
  if (range !== "live" && range !== "stream") return context.json({ error: "belabox_history_range_invalid" }, 400);
  const moduleState = await belaboxSettingsForChannel(context.env.DB, channelId);
  if (moduleState?.enabled !== true || moduleState.settings.mode !== "interval") return context.json([]);
  if (range === "live") return context.json(await getBelaboxLiveHistory(context.env.DB, channelId));

  const requestedStreamId = context.req.query("streamId");
  if (requestedStreamId !== undefined && (requestedStreamId.length === 0 || requestedStreamId.length > 128)) {
    return context.json({ error: "belabox_history_stream_invalid" }, 400);
  }
  const status = requestedStreamId === undefined ? await getBelaboxStatus(context.env.DB, channelId) : null;
  const streamId = requestedStreamId ?? status?.belaboxStreamId;
  if (streamId === null || streamId === undefined) return context.json([]);
  return context.json(await getBelaboxStreamHistory(context.env.DB, channelId, streamId));
});

belaboxRoutes.get("/streams", async (context) => {
  const channelId = channelIdOf(context);
  return context.json(await listBelaboxStreams(context.env.DB, channelId));
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
  } catch {
    return context.json({ error: "belabox_stats_url_save_failed" }, 500);
  }
  await ensurePollingBestEffort(
    context.get("runModuleAlarm"),
    context.get("writeModuleDiagnostics"),
    context.env.DB,
    channelId,
  );
  return context.json({ configured: true });
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
  } catch {
    return context.json({ error: "belabox_stats_url_remove_failed" }, 500);
  }
  await ensurePollingBestEffort(
    context.get("runModuleAlarm"),
    context.get("writeModuleDiagnostics"),
    context.env.DB,
    channelId,
  );
  return context.json({ configured: false });
});

belaboxRoutes.post("/polling/retry", async (context) => {
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  await ensurePollingBestEffort(
    context.get("runModuleAlarm"),
    context.get("writeModuleDiagnostics"),
    context.env.DB,
    channelIdOf(context),
  );
  return context.json({ ensured: true });
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
