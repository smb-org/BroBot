interface ChannelIdRow {
  channel_id: string;
}

export const listChannelIds = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare("SELECT channel_id FROM channels ORDER BY channel_id").all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

export const listChannelIdsWithoutStreamState = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare(
    `SELECT channel.channel_id
       FROM channels AS channel
       LEFT JOIN channel_stream_state AS stream_state
         ON stream_state.channel_id = channel.channel_id
      WHERE stream_state.channel_id IS NULL
      ORDER BY channel.channel_id`,
  ).all<ChannelIdRow>();
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

