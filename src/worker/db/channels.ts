interface ChannelIdRow {
  channel_id: string;
}

export const listChannelIds = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare("SELECT channel_id FROM channels ORDER BY channel_id").all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

export const listChannelIdsForUser = async (db: D1Database, userId: string): Promise<string[]> => {
  const result = await db.prepare(
    `SELECT channel_id
       FROM channel_members
      WHERE user_id = ?
      ORDER BY channel_id`,
  ).bind(userId).all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

