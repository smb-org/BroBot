/**
 * Resolve the one-time migration candidates against the close alarms still
 * persisted by the channel Durable Object. D1 batch execution keeps the vote
 * flag and candidate cleanup atomic.
 */
export const reconcileLegacyChatVoteResultDeliveries = async (
  database: D1Database,
  channelId: string,
  retainedPollIds: readonly string[],
): Promise<void> => {
  const retainedJson = JSON.stringify([...new Set(retainedPollIds)]);
  await database.batch([
    database.prepare(
      `UPDATE chat_votes
          SET result_delivery_pending = 0
        WHERE channel_id = ?
          AND result_delivery_pending = 1
          AND EXISTS (
            SELECT 1
              FROM chat_vote_result_delivery_reconciliation AS candidate
             WHERE candidate.channel_id = chat_votes.channel_id
               AND candidate.poll_id = chat_votes.poll_id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(?) AS retained
             WHERE retained.value = chat_votes.poll_id
          )`,
    ).bind(channelId, retainedJson),
    database.prepare(
      `DELETE FROM chat_vote_result_delivery_reconciliation AS candidate
        WHERE channel_id = ?
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(?) AS retained
             WHERE retained.value = candidate.poll_id
          )`,
    ).bind(channelId, retainedJson),
  ]);
};
