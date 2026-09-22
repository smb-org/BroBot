export type AuditActorKind = "mitglied" | "betreiber";

const auditId = (): string => crypto.randomUUID();

/**
 * Der zweite Teil wird mit der Fachmutation gebatcht. `changes()` verhindert,
 * dass ein abgelehnter oder ins Leere laufender Schreibversuch auditiert wird.
 */
export const prepareAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  channelId: string,
  moduleId: string | null,
  action: string,
  before: object | null,
  after: object | null,
  actorKind: AuditActorKind = "mitglied",
): D1PreparedStatement => db.prepare(
  `INSERT INTO audit_log
    (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE changes() > 0`,
).bind(
  auditId(),
  actorUserId,
  changedAt,
  channelId,
  moduleId,
  action,
  JSON.stringify(before),
  JSON.stringify(after),
  actorKind,
);

