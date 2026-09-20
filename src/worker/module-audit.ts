import type { ModuleAuditEntry } from "../modules/contract";

const auditId = (): string => crypto.randomUUID();

/**
 * Der zweite Teil wird mit der Fachmutation gebatcht. `changes()` verhindert,
 * dass ein abgelehnter oder ins Leere laufender Schreibversuch auditiert wird.
 */
export const prepareModuleAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  entry: ModuleAuditEntry,
): D1PreparedStatement => db.prepare(
  `INSERT INTO audit_log
    (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE changes() > 0`,
).bind(
  auditId(),
  actorUserId,
  changedAt,
  entry.channelId,
  entry.moduleId,
  entry.action,
  JSON.stringify(entry.before),
  JSON.stringify(entry.after),
);
