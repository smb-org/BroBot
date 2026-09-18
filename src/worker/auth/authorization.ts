import type { SessionRecord } from "./repository";

export type ChannelMemberRole = "broadcaster" | "verwalter" | "bediener";

interface ChannelMemberRoleRow {
  role: ChannelMemberRole;
}

const isChannelMemberRole = (value: string): value is ChannelMemberRole =>
  value === "broadcaster" || value === "verwalter" || value === "bediener";

export const authorizeChannelAccess = async (
  db: D1Database,
  session: Pick<SessionRecord, "userId"> | null,
  channelId: string,
): Promise<ChannelMemberRole | null> => {
  if (session === null) return null;
  const row = await db.prepare(
    `SELECT member.role
       FROM channels AS channel
       JOIN channel_members AS member ON member.channel_id = channel.channel_id
      WHERE channel.channel_id = ?
        AND member.user_id = ?`,
  ).bind(channelId, session.userId).first<ChannelMemberRoleRow>();
  return row !== null && isChannelMemberRole(row.role) ? row.role : null;
};
