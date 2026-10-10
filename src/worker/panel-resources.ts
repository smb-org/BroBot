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
  authRoutes: "/auth/*",
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
  return revisions;
};

const publishPendingSharedResourceChanges = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  alreadyReconciled = new Map<string, PanelResourceRevisionVector>(),
): Promise<void> => {
  const pending = await env.DB.prepare(
    `SELECT global.resource, global.revision
       FROM panel_global_resource_revisions AS global
       LEFT JOIN panel_global_resource_publications AS published USING (resource)
      WHERE global.resource IN ('channels', 'weather.cache', 'api.cache')
        AND global.revision > COALESCE(published.revision, 0)`,
  ).all<{ resource: string; revision: number }>();
  if (pending.results.length === 0) return;
  const channels = await env.DB.prepare("SELECT channel_id FROM channels").all<{ channel_id: string }>();
  await Promise.all(channels.results
    .filter(({ channel_id }) => {
      const vector = alreadyReconciled.get(channel_id);
      return vector === undefined || pending.results.some(({ resource, revision }) => (vector[resource] ?? 0) < revision);
    })
    .map(({ channel_id }) => reconcileChannelResources(env, channel_id)));
  await env.DB.batch(pending.results.map(({ resource, revision }) => env.DB.prepare(
    `INSERT INTO panel_global_resource_publications (resource, revision) VALUES (?, ?)
     ON CONFLICT(resource) DO UPDATE SET revision = MAX(revision, excluded.revision)`,
  ).bind(resource, revision)));
};

/** Reads the durable D1 vector, including cross-channel query resources. */
export const readPanelResourceRevisions = async (
  database: D1Database,
  channelId: string,
): Promise<PanelResourceRevisionVector> => {
  const result = await database.prepare(
    `SELECT resource, revision
       FROM panel_resource_revisions
      WHERE channel_id = ?
     UNION ALL
     SELECT resource, revision
       FROM panel_global_resource_revisions`,
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
 */
/**
 * The one panel resource notifier. D1 triggers advance revisions in the same
 * commit as D1 writes; `resources` is for DO-only commits. Publication is a
 * best-effort wake-up because the durable vector repairs a lost hint on the
 * next hint, reconnect, or focus comparison.
 */
export const notifyCommittedResources = async (
  env: Pick<Env, "DB" | "CHANNEL">,
  channelId?: string,
  reconcileLocal?: (revisions: PanelResourceRevisionVector) => Promise<void>,
): Promise<void> => {
  if (channelId === undefined) {
    try {
      const channels = await env.DB.prepare("SELECT channel_id FROM channels").all<{ channel_id: string }>();
      const reconciled = new Map<string, PanelResourceRevisionVector>();
      await Promise.all(channels.results.map(async ({ channel_id }) => {
        reconciled.set(channel_id, await reconcileChannelResources(env, channel_id));
      }));
      await publishPendingSharedResourceChanges(env, reconciled);
    } catch (error: unknown) {
      console.warn("Cross-channel panel resources could not be published.", error);
    }
    return;
  }
  const reconciled = new Map<string, PanelResourceRevisionVector>();
  try {
    const exists = await env.DB.prepare("SELECT 1 AS present FROM channels WHERE channel_id = ?")
      .bind(channelId).first<{ present: number }>();
    if (exists !== null) {
      const revisions = reconcileLocal === undefined
        ? await reconcileChannelResources(env, channelId)
        : await readPanelResourceRevisions(env.DB, channelId);
      if (reconcileLocal !== undefined) await reconcileLocal(revisions);
      reconciled.set(channelId, revisions);
    }
  } catch (error: unknown) {
    console.warn("Committed panel resources could not be published.", error);
  }
  try {
    await publishPendingSharedResourceChanges(env, reconciled);
  } catch (error: unknown) {
    console.warn("Shared panel resources could not be published.", error);
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
