import type { RealtimeEnvelope } from "../realtime-contract";

export type PanelResourceRevisionVector = Readonly<Record<string, number>>;

export interface PanelResourceRevisionRow {
  resource: string;
  revision: number;
}

const MAX_PANEL_RESOURCES = 128;
const MAX_PENDING_CHANNELS_PER_CLAIM = 32;
const MAX_CONCURRENT_PANEL_RECONCILIATIONS = 4;
const PANEL_RESOURCE_CLAIM_LEASE_MS = 5 * 60 * 1_000;

interface ClaimedPanelChannels {
  channelIds: string[];
  claimToken: string;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const PANEL_RESOURCE_NOTIFIER_COVERAGE = {
  channelRoutes: "/api/channels/:channelId/*",
  moduleRoutes: "channelRoutes",
  platformRoutes: "/api/platform/*",
  explicitlyCommittedRoutes: [
    "GET /auth/twitch/callback",
    "GET /api/overlay/bootstrap",
    "GET /api/overlay/variables/:name",
  ],
  nonPanelGetRoutes: [
    "/healthz",
    "/overlay",
    "/overlay.html",
    "/api/channels",
    "/api/csrf",
    "/api/platform",
    "/api/platform/users",
    "/api/platform/channels",
    "/api/platform/channels/:channelId/members",
    "/api/platform/audit",
    "/auth/login",
    "/auth/channels/:channelId/channel-bot",
    "/auth/channels/:channelId/broadcaster-scopes/:moduleId",
    "/auth/bot/login",
    "/ws/channels/:channelId",
    "/ws/overlay",
  ],
  nonPanelWriteRoutes: ["POST /auth/logout"],
  nonPanelAllRoutes: ["ALL /api/*", "ALL /*"],
  eventSubRoute: "/api/twitch/eventsub",
  eventSubHandler: "eventSubRouter notification/revocation finally",
  channelAlarm: "ChannelObject.alarm.finally",
  scheduledMaintenance: "scheduled.finally",
} as const;

const reconcileChannelResources = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  channelId: string,
  claimToken: string,
  reconcileLocal?: (revisions: PanelResourceRevisionVector) => Promise<void>,
): Promise<PanelResourceRevisionVector> => {
  const revisions = await readPanelResourceRevisions(env.DB, channelId);
  if (reconcileLocal === undefined) {
    await env.CHANNEL.get(env.CHANNEL.idFromName(channelId)).reconcilePanelResources(revisions);
  } else {
    await reconcileLocal(revisions);
  }
  await clearDeliveredPanelResources(env.DB, channelId, revisions, claimToken);
  return revisions;
};

const clearDeliveredPanelResources = async (
  database: D1Database,
  channelId: string,
  revisions: PanelResourceRevisionVector,
  claimToken: string,
): Promise<void> => {
  const entries = Object.entries(revisions);
  await database.batch([
    database.prepare(
      `DELETE FROM panel_resource_pending
        WHERE channel_id = ? AND claim_token = ?
          AND NOT EXISTS (
            SELECT 1 FROM panel_resource_revisions AS revisions
             WHERE revisions.channel_id = panel_resource_pending.channel_id
               AND revisions.resource = panel_resource_pending.resource
          )`,
    ).bind(channelId, claimToken),
    ...entries.map(([resource, revision]) => database.prepare(
      `DELETE FROM panel_resource_pending
        WHERE channel_id = ? AND resource = ? AND revision <= ? AND claim_token = ?`,
    ).bind(channelId, resource, revision, claimToken)),
    database.prepare(
      `UPDATE panel_resource_pending
          SET claimed_until = NULL, claim_token = NULL
        WHERE channel_id = ? AND claim_token = ?`,
    ).bind(channelId, claimToken),
  ]);
};

/** Claims every queued resource for a bounded set of channels in one atomic D1 statement. */
const claimPendingChannels = async (
  database: D1Database,
  preferredChannelId?: string,
): Promise<ClaimedPanelChannels> => {
  const claimToken = crypto.randomUUID();
  const now = Date.now();
  await database.prepare(
    `UPDATE panel_resource_pending
        SET claimed_until = ?, claim_token = ?
      WHERE channel_id IN (
        SELECT channel_id
          FROM panel_resource_pending
         GROUP BY channel_id
        HAVING MAX(COALESCE(claimed_until, 0)) <= ?
         ORDER BY CASE WHEN channel_id = ? THEN 0 ELSE 1 END, channel_id
         LIMIT ?
      )`,
  ).bind(
    now + PANEL_RESOURCE_CLAIM_LEASE_MS,
    claimToken,
    now,
    preferredChannelId ?? "",
    MAX_PENDING_CHANNELS_PER_CLAIM,
  ).run();
  const result = await database.prepare(
    `SELECT DISTINCT channel_id
       FROM panel_resource_pending
      WHERE claim_token = ?
      ORDER BY channel_id`,
  ).bind(claimToken).all<{ channel_id: string }>();
  const channelIds = result.results.flatMap(({ channel_id }) =>
    typeof channel_id === "string" && channel_id.length > 0 ? [channel_id] : []);
  return { channelIds, claimToken };
};

const channelHasPendingResources = async (database: D1Database, channelId: string): Promise<boolean> => {
  const result = await database.prepare(
    "SELECT 1 AS queued FROM panel_resource_pending WHERE channel_id = ? LIMIT 1",
  ).bind(channelId).all<{ queued: number }>();
  return result.results.some(({ queued }) => queued === 1);
};

const reconcileClaimedChannels = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  claim: ClaimedPanelChannels,
  localChannelId: string | undefined,
  reconcileLocal: ((revisions: PanelResourceRevisionVector) => Promise<void>) | undefined,
): Promise<boolean> => {
  let next = 0;
  let localChannelWasReconciled = false;
  let failedDeliveries = 0;
  let firstDeliveryError: unknown;
  const workerCount = Math.min(MAX_CONCURRENT_PANEL_RECONCILIATIONS, claim.channelIds.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < claim.channelIds.length) {
      const channelId = claim.channelIds[next++];
      if (channelId === undefined) continue;
      const useLocalReconciliation = channelId === localChannelId && reconcileLocal !== undefined;
      if (useLocalReconciliation) localChannelWasReconciled = true;
      try {
        await reconcileChannelResources(
          env,
          channelId,
          claim.claimToken,
          useLocalReconciliation ? reconcileLocal : undefined,
        );
      } catch (error: unknown) {
        // Keep the lease after a failed delivery. A later drain can reclaim
        // it after expiry without duplicating an in-flight Durable Object call.
        failedDeliveries += 1;
        firstDeliveryError ??= error;
      }
    }
  }));
  if (failedDeliveries > 0) {
    console.warn(
      `Committed panel resources could not be published to ${String(failedDeliveries)} channels.`,
      errorMessage(firstDeliveryError),
    );
  }
  return localChannelWasReconciled;
};

/** Reads the durable D1 vector for one channel. */
export const readPanelResourceRevisions = async (
  database: D1Database,
  channelId: string,
): Promise<PanelResourceRevisionVector> => {
  const result = await database.prepare(
    `SELECT resource, revision
       FROM panel_resource_revisions
      WHERE channel_id = ?`,
  ).bind(channelId).all<PanelResourceRevisionRow>();
  return Object.fromEntries(result.results.map(({ resource, revision }) => [resource, revision]));
};

/** D1 and DO counters are summed for resources written in both transaction domains. */
export const readCompletePanelResourceRevisions = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  channelId: string,
): Promise<PanelResourceRevisionVector> => {
  const [databaseRevisions, durableObjectRevisions] = await Promise.all([
    readPanelResourceRevisions(env.DB, channelId),
    env.CHANNEL.get(env.CHANNEL.idFromName(channelId)).getPanelResourceRevisions(),
  ]);
  const revisions = { ...databaseRevisions };
  for (const [resource, revision] of Object.entries(durableObjectRevisions)) {
    revisions[resource] = (revisions[resource] ?? 0) + revision;
  }
  return revisions;
};

/**
 * D1 triggers and Durable Object transactions each persist revisions beside
 * their own committed data. The panel vector combines both counter domains.
 * D1's pending table is the commit-coupled channel queue, so a request only
 * visits channels with committed, unpublished changes.
 */
export const notifyCommittedResources = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  channelId?: string,
  reconcileLocal?: (revisions: PanelResourceRevisionVector) => Promise<void>,
): Promise<void> => {
  let localChannelWasReconciled = false;
  let queueDrainFailed = false;
  try {
    let claim = await claimPendingChannels(env.DB, channelId);
    while (claim.channelIds.length > 0) {
      const localWasReconciled = await reconcileClaimedChannels(env, claim, channelId, reconcileLocal);
      localChannelWasReconciled = localChannelWasReconciled || localWasReconciled;
      claim = await claimPendingChannels(env.DB, channelId);
    }
  } catch (error: unknown) {
    queueDrainFailed = true;
    console.warn("Committed panel resources could not be claimed.", errorMessage(error));
  }

  if (channelId !== undefined && reconcileLocal !== undefined && !localChannelWasReconciled) {
    let revisions: PanelResourceRevisionVector = {};
    try {
      // DO-only commits have no D1 queue row. Reconcile them locally; if a
      // D1 row is leased by another drain, that drain owns its publication.
      if (!queueDrainFailed && await channelHasPendingResources(env.DB, channelId)) return;
    } catch (error: unknown) {
      console.warn("Committed panel resources could not be checked locally.", channelId, errorMessage(error));
    }
    try {
      revisions = await readPanelResourceRevisions(env.DB, channelId);
    } catch (error: unknown) {
      // Local DO revisions are independent of D1 and still need a same-DO
      // notification when the D1 queue or revision read is unavailable.
      console.warn("Committed panel resource revisions could not be read locally.", channelId, errorMessage(error));
    }
    try {
      await reconcileLocal(revisions);
    } catch (error: unknown) {
      console.warn("Committed panel resources could not be published locally.", channelId, errorMessage(error));
    }
  }
};

export const panelResourceChangedMessage = (
  channelId: string,
  resources: readonly string[],
  revisions: PanelResourceRevisionVector,
): RealtimeEnvelope<"panel.resources.changed"> => {
  const boundedResources = [...new Set(resources)].sort((left, right) => left.localeCompare(right)).slice(0, MAX_PANEL_RESOURCES);
  const boundedRevisions = Object.fromEntries(boundedResources.flatMap((resource) => {
    const revision = revisions[resource];
    return revision === undefined ? [] : [[resource, revision] as const];
  }));
  return {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    channelId,
    type: "panel.resources.changed",
    payload: { resources: boundedResources, revisions: boundedRevisions },
  };
};
