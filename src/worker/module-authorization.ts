import type { AuthorizeModuleMutation } from "../modules/contract";
import {
  actorGuard,
  bindActorGuard,
  ANY_MEMBER_ROLES,
  type ActorContext,
} from "./db/guards";

/** Liefert dem Modul nur die bereits geprüfte SQL-Bedingung, nicht channel_members. */
export const authorizeModuleMutation: AuthorizeModuleMutation = (channelId, actor, now) => {
  if (actor.sessionId !== undefined) {
    const context: ActorContext = { userId: actor.userId, sessionId: actor.sessionId };
    return { sql: actorGuard(ANY_MEMBER_ROLES), values: bindActorGuard(context, channelId, now) };
  }
  return {
    sql: `
          AND EXISTS (
            SELECT 1 FROM channel_members
             WHERE channel_id = ? AND user_id = ?
          )`,
    values: [channelId, actor.userId],
  };
};

/** Dieselbe verwaltende Schwelle wie bei der Modulaktivierung. */
export const authorizeModuleManagementMutation: AuthorizeModuleMutation = (channelId, actor, now) => {
  if (actor.sessionId !== undefined) {
    const context: ActorContext = { userId: actor.userId, sessionId: actor.sessionId };
    return { sql: actorGuard("'broadcaster', 'manager'"), values: bindActorGuard(context, channelId, now) };
  }
  return {
    sql: `
          AND EXISTS (
            SELECT 1 FROM channel_members
             WHERE channel_id = ? AND user_id = ?
               AND role IN ('broadcaster', 'manager')
          )`,
    values: [channelId, actor.userId],
  };
};
