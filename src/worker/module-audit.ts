import { prepareAudit } from "./db/audit";
import type { ModuleAuditEntry } from "../modules/contract";
import type { AuditActorKind } from "../contracts/values";

export type { AuditActorKind } from "../contracts/values";

/**
 * Der zweite Teil wird mit der Fachmutation gebatcht. `changes()` verhindert,
 * dass ein abgelehnter oder ins Leere laufender Schreibversuch auditiert wird.
 */
export const prepareModuleAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  entry: ModuleAuditEntry,
  actorKind: AuditActorKind = "mitglied",
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
