import type { ChannelMemberRecord } from "./channel-members";

/**
 * Der Akteur einer Mutation. Die sessionId gehoert dazu, weil die Mutation
 * selbst pruefen muss, ob die Session noch lebt — die Rolle allein genuegt
 * nicht.
 */
export interface ActorContext {
  userId: string;
  sessionId: string;
}

/**
 * Der Handler prueft die Berechtigung, bevor er den Request-Body liest. Zwischen
 * Guard und Mutation liegt aber ein beliebig langes Fenster: Ein Client kann den
 * Body offen lassen, bis seine Session widerrufen wurde, und ihn erst danach
 * schliessen. Deshalb wiederholt jede Mutation die vollstaendige Pruefung im
 * selben D1-Batch — nicht nur die Kanalrolle, sondern auch die Session selbst.
 *
 * Bindereihenfolge: sessionId, actorUserId, now, channelId.
 */
export const actorGuard = (allowedRoles: string): string => `
        AND EXISTS (
          SELECT 1
            FROM auth_sessions AS actor_session
            JOIN twitch_login_identity AS actor_identity
              ON actor_identity.user_id = actor_session.user_id
            JOIN channel_members AS actor
              ON actor.user_id = actor_session.user_id
           WHERE actor_session.session_id = ?
             AND actor_session.user_id = ?
             AND actor_session.revoked_at IS NULL
             AND actor_session.expires_at > ?
             AND actor_identity.status <> 'revoked'
             AND actor.channel_id = ?
             AND actor.role IN (${allowedRoles})
        )`;

export interface MutationGuard {
  sql: string;
  values: readonly (string | number | null)[];
}

export const betreiberSessionGuard = (
  actor: ActorContext,
  now: string,
): MutationGuard => ({
  sql: `
        AND EXISTS (
          SELECT 1
            FROM auth_sessions AS actor_session
            JOIN twitch_login_identity AS actor_identity
              ON actor_identity.user_id = actor_session.user_id
           WHERE actor_session.session_id = ?
             AND actor_session.user_id = ?
             AND actor_session.revoked_at IS NULL
             AND actor_session.expires_at > ?
             AND actor_identity.status <> 'revoked'
        )`,
  values: [actor.sessionId, actor.userId, now],
});

/**
 * Wer die Rolle `broadcaster` vergibt, kann den bisherigen Broadcaster
 * anschliessend entfernen — der Schutz des letzten Broadcasters greift dann
 * nicht mehr, weil zwischenzeitlich zwei existieren. Deshalb darf nur ein
 * Broadcaster diese Rolle vergeben. Die Regel steht hier und nicht nur im
 * Handler, damit sie auch dann gilt, wenn sich die Rolle zwischen Guard und
 * Mutation aendert.
 */
export const ANY_MEMBER_ROLES = "'broadcaster', 'verwalter', 'bediener'";

/** Gemeinsame SQL-Prüfung der Broadcaster-Zustimmung für channel:bot. */
export const channelBotConsentCondition = (channelAlias: string): string => `
        EXISTS (
          SELECT 1
            FROM twitch_login_identity AS broadcaster_identity
           WHERE broadcaster_identity.user_id = ${channelAlias}.channel_id
             AND broadcaster_identity.status = 'connected'
             AND EXISTS (
               SELECT 1
                 FROM json_each(broadcaster_identity.scopes_json) AS granted_scope
                WHERE granted_scope.value = 'channel:bot'
             )
        )`;

export const requiredActorRoles = (
  targetRole: ChannelMemberRecord["role"] | undefined,
  existingRole?: ChannelMemberRecord["role"],
): string => targetRole === "broadcaster" || existingRole === "broadcaster"
  ? "'broadcaster'"
  : "'broadcaster', 'verwalter'";

export const bindActorGuard = (actor: ActorContext, channelId: string, now: string) =>
  [actor.sessionId, actor.userId, now, channelId] as const;

const soleBroadcasterPredicate = `
          AND (
            SELECT COUNT(*)
              FROM channel_members
             WHERE channel_id = ? AND role = 'broadcaster'
          ) <= 1`;

export const lastBroadcasterGuard = `
        AND NOT (
          role = 'broadcaster'
          ${soleBroadcasterPredicate}
        )`;

export const lastBroadcasterRoleChangeGuard = `
        AND NOT (
          role = 'broadcaster'
          AND ? <> 'broadcaster'
          ${soleBroadcasterPredicate}
        )`;

