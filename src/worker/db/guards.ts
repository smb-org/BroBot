import type { ChannelMemberRecord } from "./channel-members";

/**
 * The actor of a mutation. sessionId is part of it because the mutation
 * itself has to check whether the session is still alive — the role alone
 * is not enough.
 */
export interface ActorContext {
  userId: string;
  sessionId: string;
}

/**
 * The handler checks the authorization before reading the request body. But
 * an arbitrarily long window lies between guard and mutation: a client can
 * leave the body open until its session has been revoked, and only close
 * it afterward. That's why every mutation repeats the full check in the
 * same D1 batch — not just the channel role, but the session itself too.
 *
 * Bind order: sessionId, actorUserId, now, channelId.
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

export const platformSessionGuard = (
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
 * Whoever grants the `broadcaster` role can afterward remove the previous
 * broadcaster — the last-broadcaster protection no longer applies at that
 * point, because two exist in the meantime. That's why only a broadcaster
 * may grant this role. The rule lives here and not only in the handler, so
 * it still applies even if the role changes between guard and mutation.
 */
export const ANY_MEMBER_ROLES = "'broadcaster', 'manager', 'operator'";

/** Shared SQL check for the broadcaster's channel:bot consent. */
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
  : "'broadcaster', 'manager'";

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

