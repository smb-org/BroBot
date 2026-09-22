import { prepareAudit, recordAudit } from "./db/audit";
import type { ModuleAuditEntry } from "../modules/contract";
import type { AuditActorKind } from "../contracts/values";

export type { AuditActorKind } from "../contracts/values";

/**
 * The second part is batched with the domain mutation. `changes()` prevents
 * a rejected or no-op write attempt from being audited.
 */
export const prepareModuleAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  entry: ModuleAuditEntry,
  actorKind: AuditActorKind = "member",
): D1PreparedStatement => prepareAudit(
  db,
  actorUserId,
  changedAt,
  entry.channelId,
  entry.moduleId,
  entry.action,
  entry.before,
  entry.after,
  actorKind,
);

/** Immediate counterpart for an action with no D1 mutation to batch it with. */
export const writeModuleAudit = async (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  entry: ModuleAuditEntry,
  actorKind: AuditActorKind = "member",
): Promise<void> => recordAudit(
  db,
  actorUserId,
  changedAt,
  entry.channelId,
  entry.moduleId,
  entry.action,
  entry.before,
  entry.after,
  actorKind,
);
