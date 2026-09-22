import type {
  SessionRecord,
} from "../db/sessions";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";

interface ChannelRoleRow {
  role: ChannelRole;
}

const isChannelRole = (value: string): value is ChannelRole =>
  CHANNEL_ROLES.includes(value as ChannelRole);

export const authorizeChannelAccess = async (
  db: D1Database,
  session: Pick<SessionRecord, "userId"> | null,
  channelId: string,
): Promise<ChannelRole | null> => {
  if (session === null) return null;
  const row = await db.prepare(
    `SELECT member.role
       FROM channels AS channel
       JOIN channel_members AS member ON member.channel_id = channel.channel_id
      WHERE channel.channel_id = ?
        AND member.user_id = ?`,
  ).bind(channelId, session.userId).first<ChannelRoleRow>();
  return row !== null && isChannelRole(row.role) ? row.role : null;
};
