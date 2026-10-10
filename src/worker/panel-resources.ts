import type { RealtimeEnvelope } from "../realtime-contract";

export type PanelResourceRevisionVector = Readonly<Record<string, number>>;

export interface PanelResourceRevisionRow {
  resource: string;
  revision: number;
}

const MAX_PANEL_RESOURCES = 128;

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
): Promise<PanelResourceRevisionVector> => {
  const revisions = await readPanelResourceRevisions(env.DB, channelId);
  await env.CHANNEL.get(env.CHANNEL.idFromName(channelId)).reconcilePanelResources(revisions);
  await clearDeliveredPanelResources(env.DB, channelId, revisions);
  return revisions;
};

const clearDeliveredPanelResources = async (
  database: D1Database,
  channelId: string,
  revisions: PanelResourceRevisionVector,
): Promise<void> => {
  const entries = Object.entries(revisions);
  if (entries.length === 0) return;
  await database.batch(entries.map(([resource, revision]) => database.prepare(
    `DELETE FROM panel_resource_pending
      WHERE channel_id = ? AND resource = ? AND revision <= ?`,
  ).bind(channelId, resource, revision)));
};

const pendingChannelIds = async (database: D1Database): Promise<string[]> => {
  const result = await database.prepare(
    "SELECT DISTINCT channel_id FROM panel_resource_pending ORDER BY channel_id",
  ).all<{ channel_id: string }>();
  return result.results.map(({ channel_id }) => channel_id);
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
  if (channelId === undefined) {
    try {
      await Promise.all((await pendingChannelIds(env.DB)).map((pendingChannelId) =>
        reconcileChannelResources(env, pendingChannelId)));
    } catch (error: unknown) {
      console.warn("Committed panel resources could not be published.", error);
    }
    return;
  }
  try {
    const pending = await env.DB.prepare(
      "SELECT 1 AS present FROM panel_resource_pending WHERE channel_id = ? LIMIT 1",
    ).bind(channelId).first<{ present: number }>();
    if (pending === null && reconcileLocal === undefined) return;
    const revisions = await readPanelResourceRevisions(env.DB, channelId);
    if (reconcileLocal === undefined) {
      await env.CHANNEL.get(env.CHANNEL.idFromName(channelId)).reconcilePanelResources(revisions);
    } else {
      await reconcileLocal(revisions);
    }
    await clearDeliveredPanelResources(env.DB, channelId, revisions);
  } catch (error: unknown) {
    console.warn("Committed panel resources could not be published.", error);
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
