import type { AuditActorKind, AuditWriteAction } from "../../contracts/values";

const auditId = (): string => crypto.randomUUID();

/**
 * The second part is batched with the domain mutation. `changes()` prevents
 * a rejected or no-op write attempt from being audited.
 */
/**
 * Unconditional variant for an action with no accompanying D1 mutation to
 * gate `changes()` on -- an external Twitch call (start a commercial,
 * create a clip), not a row change here. Runs immediately instead of
 * returning a statement to batch.
 */
export const recordAudit = async (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  channelId: string,
  moduleId: string | null,
  action: AuditWriteAction,
  before: object | null,
  after: object | null,
  actorKind: AuditActorKind = "member",
): Promise<void> => {
  await db.prepare(
    `INSERT INTO audit_log
      (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(auditId(), actorUserId, changedAt, channelId, moduleId, action, JSON.stringify(before), JSON.stringify(after), actorKind).run();
};

export const prepareAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  channelId: string,
  moduleId: string | null,
  action: AuditWriteAction,
  before: object | null,
  after: object | null,
  actorKind: AuditActorKind = "member",
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
