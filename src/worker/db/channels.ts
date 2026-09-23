interface ChannelIdRow {
  channel_id: string;
}

export const listChannelIds = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare("SELECT channel_id FROM channels ORDER BY channel_id").all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

/**
 * Channels the stream-state cron should (re-)poll this tick: no row yet,
 * stale Helix rows, or EventSub rows without both active stream transition
 * subscriptions. Missing rows come first, followed by the oldest stored
 * state, so a capped tick does not starve the tail of a backlog.
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
         OR (stream_state.source = 'eventsub' AND (
              NOT EXISTS (
                SELECT 1 FROM eventsub_subscriptions
                 WHERE channel_id = channel.channel_id
                   AND subscription_type = 'stream.online'
                   AND status = 'enabled' AND subscription_id IS NOT NULL
              )
              OR NOT EXISTS (
                SELECT 1 FROM eventsub_subscriptions
                 WHERE channel_id = channel.channel_id
                   AND subscription_type = 'stream.offline'
                   AND status = 'enabled' AND subscription_id IS NOT NULL
              )
         ))
      ORDER BY CASE WHEN stream_state.channel_id IS NULL THEN 0 ELSE 1 END,
               stream_state.changed_at ASC,
               channel.channel_id ASC
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
