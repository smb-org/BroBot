import type { DiscordRoleMappings, DiscordServerConnection } from "./contracts";

export interface DiscordLink {
  discordUserId: string;
  twitchUserId: string;
  discordUsername: string;
  twitchLogin: string;
  linkedAt: string;
  verifiedAt: string;
}

export const discordLinkSelectColumns = `
  discord_user_id AS discordUserId,
  twitch_user_id AS twitchUserId,
  discord_username AS discordUsername,
  twitch_login AS twitchLogin,
  linked_at AS linkedAt,
  verified_at AS verifiedAt`;

const discordLinkConflictsQuery = `
  SELECT ${discordLinkSelectColumns}
    FROM discord_links
   WHERE discord_user_id = ? OR twitch_user_id = ?
   ORDER BY discord_user_id`;

/** Replaces either conflicting account link atomically and returns rows removed by the replacement. */
export const replaceDiscordLink = async (
  db: D1Database,
  link: DiscordLink,
): Promise<{ link: DiscordLink; replacedRows: DiscordLink[] }> => {
  const [conflicts] = await db.batch([
    db.prepare(discordLinkConflictsQuery).bind(link.discordUserId, link.twitchUserId),
    db.prepare(
      `INSERT OR REPLACE INTO discord_links
        (discord_user_id, twitch_user_id, discord_username, twitch_login, linked_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(link.discordUserId, link.twitchUserId, link.discordUsername, link.twitchLogin, link.linkedAt, link.verifiedAt),
  ]);
  const replacedRows = (conflicts?.results ?? []) as DiscordLink[];
  return { link, replacedRows };
};

export const getDiscordLink = async (db: D1Database, discordUserId: string): Promise<DiscordLink | null> =>
  db.prepare(`SELECT ${discordLinkSelectColumns} FROM discord_links WHERE discord_user_id = ?`)
    .bind(discordUserId).first<DiscordLink>();

/** Deletes the current link and returns it for the later managed-role removal hook. */
export const removeDiscordLink = async (db: D1Database, discordUserId: string): Promise<DiscordLink | null> =>
  db.prepare(`DELETE FROM discord_links WHERE discord_user_id = ? RETURNING ${discordLinkSelectColumns}`)
    .bind(discordUserId).first<DiscordLink>();

export const getDiscordServerConnection = async (
  db: D1Database,
  channelId: string,
): Promise<DiscordServerConnection | null> =>
  db.prepare(
    `SELECT channel_id AS channelId, guild_id AS guildId, connected_at AS connectedAt, connected_by AS connectedBy
       FROM discord_guilds WHERE channel_id = ?`,
  )
    .bind(channelId).first<DiscordServerConnection>();

export const getDiscordRoleMappings = async (db: D1Database, channelId: string): Promise<DiscordRoleMappings> => {
  const rows = await db.prepare(
    "SELECT rank_type, role_id FROM discord_role_mappings WHERE channel_id = ?",
  ).bind(channelId).all<{ rank_type: "vip" | "moderator"; role_id: string }>();
  return {
    vip: rows.results.find(({ rank_type }) => rank_type === "vip")?.role_id ?? null,
    moderator: rows.results.find(({ rank_type }) => rank_type === "moderator")?.role_id ?? null,
  };
};

export const connectDiscordServer = async (
  db: D1Database,
  connection: Pick<DiscordServerConnection, "channelId" | "guildId" | "connectedAt" | "connectedBy">,
): Promise<"connected" | "already_connected"> => {
  await db.batch([
    db.prepare(
      `DELETE FROM discord_role_mappings
        WHERE channel_id = ?
          AND EXISTS (
             SELECT 1 FROM discord_guilds AS existing
             WHERE existing.channel_id = ? AND existing.guild_id <> ?
               AND NOT EXISTS (
                 SELECT 1 FROM discord_guilds AS other
                  WHERE other.guild_id = ? AND other.channel_id <> ?
               )
          )`,
    ).bind(connection.channelId, connection.channelId, connection.guildId, connection.guildId, connection.channelId),
    db.prepare(
      `INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET
         guild_id = excluded.guild_id,
         connected_at = excluded.connected_at,
         connected_by = excluded.connected_by
       WHERE NOT EXISTS (
         SELECT 1 FROM discord_guilds AS other
          WHERE other.guild_id = excluded.guild_id AND other.channel_id <> excluded.channel_id
       )
       ON CONFLICT (guild_id) DO NOTHING`,
    ).bind(connection.channelId, connection.guildId, connection.connectedAt, connection.connectedBy),
  ]);
  const stored = await getDiscordServerConnection(db, connection.channelId);
  return stored?.guildId === connection.guildId ? "connected" : "already_connected";
};

export const saveDiscordRoleMappings = async (
  db: D1Database,
  channelId: string,
  mappings: DiscordRoleMappings,
  updatedAt: string,
): Promise<void> => {
  await db.batch(((["vip", "moderator"] as const).map((rankType) => {
    const roleId = mappings[rankType];
    return roleId === null
      ? db.prepare("DELETE FROM discord_role_mappings WHERE channel_id = ? AND rank_type = ?").bind(channelId, rankType)
      : db.prepare(
        `INSERT INTO discord_role_mappings (channel_id, rank_type, role_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (channel_id, rank_type) DO UPDATE SET role_id = excluded.role_id, updated_at = excluded.updated_at`,
      ).bind(channelId, rankType, roleId, updatedAt);
  })));
};

/** Disconnects the server and cascades its role mappings; callers may run role cleanup before this delete. */
export const disconnectDiscordServer = async (db: D1Database, channelId: string): Promise<void> => {
  await db.prepare("DELETE FROM discord_guilds WHERE channel_id = ?").bind(channelId).run();
};
