import { actorGuard, bindActorGuard, type ActorContext } from "./guards";
import { MANAGING_ROLES, type AuditWriteAction } from "../../contracts/values";
import { prepareModuleAudit as prepareHostModuleAudit } from "../module-audit";

export interface ChannelModuleRecord {
  channelId: string;
  moduleId: string;
  enabled: boolean;
  initialized: boolean;
  settings: string;
  revision: number;
}

interface ChannelModuleRow {
  channel_id: string;
  module_id: string;
  enabled: number;
  initialized: number;
  settings: string;
  revision: number;
}

const mapChannelModule = (row: ChannelModuleRow): ChannelModuleRecord => ({
  channelId: row.channel_id,
  moduleId: row.module_id,
  enabled: row.enabled === 1,
  initialized: row.initialized === 1,
  settings: row.settings,
  revision: row.revision,
});

const moduleAuditValue = (module: Pick<ChannelModuleRecord, "channelId" | "moduleId" | "enabled" | "settings">) => ({
  channelId: module.channelId,
  moduleId: module.moduleId,
  enabled: module.enabled,
  settings: module.settings,
});

const getChannelModule = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
): Promise<ChannelModuleRecord | null> => {
  const row = await db.prepare(
    `SELECT channel_id, module_id, enabled, initialized, settings, revision
       FROM channel_modules
      WHERE channel_id = ? AND module_id = ?`,
  ).bind(channelId, moduleId).first<ChannelModuleRow>();
  return row === null ? null : mapChannelModule(row);
};

export const getChannelModuleForChannel = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
): Promise<ChannelModuleRecord | null> => getChannelModule(db, channelId, moduleId);

/**
 * The same role threshold as for member changes: only broadcasters and
 * managers may toggle modules, enforced in the mutation's own actorGuard,
 * not just in the handler.
 */
export const createChannelModuleWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  module: Pick<ChannelModuleRecord, "channelId" | "moduleId" | "enabled" | "settings">,
  action: AuditWriteAction,
  changedAt: string,
  dependentMutations: readonly D1PreparedStatement[] = [],
): Promise<boolean> => {
  const mutation = db.prepare(
    `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, initialized)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_modules
         WHERE channel_id = ? AND module_id = ?
      )
      ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    module.channelId,
    module.moduleId,
    module.enabled ? 1 : 0,
    module.settings,
    module.enabled ? 1 : 0,
    module.channelId,
    module.moduleId,
    ...bindActorGuard(actor, module.channelId, changedAt),
  );
  const audit = prepareHostModuleAudit(db, actor.userId, changedAt, {
    channelId: module.channelId,
    moduleId: module.moduleId,
    action,
    before: null,
    after: moduleAuditValue(module),
  });
  const results = await db.batch([mutation, audit, ...dependentMutations]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const updateChannelModuleWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  moduleId: string,
  enabled: boolean,
  settings: string,
  action: AuditWriteAction,
  changedAt: string,
  dependentMutations: readonly D1PreparedStatement[] = [],
  expectedRevision?: number,
  markInitialized = false,
  textBlockGuard?: { sql: string; values: readonly (string | number)[] },
): Promise<boolean> => {
  const before = await getChannelModule(db, channelId, moduleId);
  if (before === null) return false;
  const after: ChannelModuleRecord = {
    channelId,
    moduleId,
    enabled,
    initialized: before.initialized || markInitialized,
    settings,
    revision: before.revision + 1,
  };
  const mutation = db.prepare(
    `UPDATE channel_modules
        SET enabled = ?, settings = ?, initialized = ?, revision = revision + 1
      WHERE channel_id = ? AND module_id = ?
        AND revision = ?
        ${textBlockGuard?.sql ?? ""}
      ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    after.enabled ? 1 : 0,
    after.settings,
    after.initialized ? 1 : 0,
    after.channelId,
    after.moduleId,
    expectedRevision ?? before.revision,
    ...(textBlockGuard?.values ?? []),
    ...bindActorGuard(actor, after.channelId, changedAt),
  );
  const audit = prepareHostModuleAudit(db, actor.userId, changedAt, {
    channelId,
    moduleId,
    action,
    before: moduleAuditValue(before),
    after: moduleAuditValue(after),
  });
  const results = await db.batch([mutation, audit, ...dependentMutations]);
  return (results[0]?.meta.changes ?? 0) > 0;
};
