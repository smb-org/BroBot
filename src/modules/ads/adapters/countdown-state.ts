import type { AdCountdownState } from "../contracts/countdown-state";

export type { AdCountdownState } from "../contracts/countdown-state";

interface AdCountdownRow {
  next_ad_at: string | null;
  duration: number | null;
}

export const readAdCountdownState = async (db: D1Database, channelId: string): Promise<AdCountdownState> => {
  const row = await db.prepare(
    "SELECT next_ad_at, duration FROM ads_countdown_state WHERE channel_id = ?",
  ).bind(channelId).first<AdCountdownRow>();
  return row === null
    ? { nextAdAt: null, duration: null }
    : { nextAdAt: row.next_ad_at, duration: row.duration };
};

/** Mirrors only schedule changes needed to hydrate overlays; the browser owns countdown ticks. */
export const writeAdCountdownState = async (
  db: D1Database,
  channelId: string,
  state: AdCountdownState,
  updatedAt: string,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO ads_countdown_state (channel_id, next_ad_at, duration, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       next_ad_at = excluded.next_ad_at,
       duration = excluded.duration,
       updated_at = excluded.updated_at`,
  ).bind(channelId, state.nextAdAt, state.duration, updatedAt).run();
};
