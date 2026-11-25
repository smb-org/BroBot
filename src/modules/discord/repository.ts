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
