interface BotChannelStatusCheckLockRow {
  channel_id: string;
  locked_until: string;
}

interface BotChannelStatusCheckedAtRow {
  checked_at: string;
}

export const tryReserveBotChannelStatusCheck = async (
  db: D1Database,
  channelId: string,
  lockedUntil: string,
  now: string,
  checkedSince: string,
): Promise<string | null> => {
  const ownerId = crypto.randomUUID();
  const row = await db.prepare(
    `INSERT INTO bot_channel_status_check_locks (channel_id, owner_id, locked_until)
     SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM bot_channel_status
         WHERE channel_id = ?
           AND julianday(checked_at) > julianday(?)
      )
     ON CONFLICT(channel_id) DO UPDATE SET
       owner_id = excluded.owner_id,
       locked_until = excluded.locked_until
     WHERE julianday(bot_channel_status_check_locks.locked_until) <= julianday(?)
       AND bot_channel_status_check_locks.owner_id <> excluded.owner_id
       AND NOT EXISTS (
         SELECT 1 FROM bot_channel_status
          WHERE channel_id = ?
            AND julianday(checked_at) > julianday(?)
       )
     RETURNING owner_id`,
  ).bind(channelId, ownerId, lockedUntil, channelId, checkedSince, now, channelId, checkedSince)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
};

export const getBotChannelStatusCheckLock = async (
  db: D1Database,
  channelId: string,
): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT channel_id, locked_until
       FROM bot_channel_status_check_locks
      WHERE channel_id = ?`,
  ).bind(channelId).first<BotChannelStatusCheckLockRow>();
  return row?.locked_until ?? null;
};

export const getBotChannelStatusCheckedAt = async (
  db: D1Database,
  channelId: string,
): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT checked_at
       FROM bot_channel_status
      WHERE channel_id = ?`,
  ).bind(channelId).first<BotChannelStatusCheckedAtRow>();
  return row?.checked_at ?? null;
};

export const releaseBotChannelStatusCheck = async (
  db: D1Database,
  channelId: string,
  ownerId: string,
): Promise<void> => {
  await db.prepare(
    "DELETE FROM bot_channel_status_check_locks WHERE channel_id = ? AND owner_id = ?",
  ).bind(channelId, ownerId).run();
};

const prepareBotChannelStatusMutation = (
  db: D1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): D1PreparedStatement => db.prepare(
  `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(channel_id) DO UPDATE SET
     is_moderator = excluded.is_moderator,
     checked_at = excluded.checked_at,
     reason = excluded.reason
   WHERE julianday(bot_channel_status.checked_at) < julianday(excluded.checked_at)`,
).bind(channelId, isModerator ? 1 : 0, checkedAt, reason);

export const setBotChannelStatus = async (
  db: D1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): Promise<void> => {
  await prepareBotChannelStatusMutation(db, channelId, isModerator, checkedAt, reason).run();
};

export const setBotChannelStatusAndLock = async (
  db: D1Database,
  channelId: string,
  ownerId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
  lockedUntil: string,
): Promise<void> => {
  await db.batch([
    prepareBotChannelStatusMutation(db, channelId, isModerator, checkedAt, reason),
    db.prepare(
      `UPDATE bot_channel_status_check_locks
          SET locked_until = ?
        WHERE channel_id = ?
          AND owner_id = ?
          AND EXISTS (
            SELECT 1 FROM bot_channel_status
             WHERE channel_id = ? AND checked_at = ?
          )`,
    ).bind(lockedUntil, channelId, ownerId, channelId, checkedAt),
    db.prepare(
      `DELETE FROM bot_channel_status_check_locks
        WHERE channel_id = ?
          AND owner_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM bot_channel_status
             WHERE channel_id = ? AND checked_at = ?
          )`,
    ).bind(channelId, ownerId, channelId, checkedAt),
  ]);
};

