interface ChannelIdRow {
  channel_id: string;
}

export const listChannelIds = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare("SELECT channel_id FROM channels ORDER BY channel_id").all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

/**
 * Channels the stream-state cron should (re-)poll this tick: no row yet, or
 * a Helix-sourced row old enough to have expired (#178) -- never an
 * EventSub-sourced row, which stays fresh on its own. `limit` caps how many
 * a single tick takes on, so a large backlog can't turn one run into an
 * unbounded burst of Helix calls.
 */
export const listChannelIdsNeedingStreamStateRefresh = async (
  db: D1Database,
  now: string,
  ttlSeconds: number,
  limit: number,
): Promise<string[]> => {
  const result = await db.prepare(
    `SELECT channel.channel_id
       FROM channels AS channel
       LEFT JOIN channel_stream_state AS stream_state
         ON stream_state.channel_id = channel.channel_id
      WHERE stream_state.channel_id IS NULL
         OR (stream_state.source = 'helix'
             AND strftime('%s', ?) - strftime('%s', stream_state.changed_at) >= ?)
      ORDER BY channel.channel_id
      LIMIT ?`,
  ).bind(now, ttlSeconds, limit).all<ChannelIdRow>();
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

