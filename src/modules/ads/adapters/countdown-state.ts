import type { AdCountdownState } from "../contracts/countdown-state";

export type { AdCountdownState } from "../contracts/countdown-state";

interface AdCountdownRow {
  next_ad_at: string | null;
  duration: number | null;
  snooze_count: number | null;
  snooze_refresh_at: string | null;
}

export type AdCountdownSnapshot = Omit<AdCountdownState, "serverNow">;

export const readAdCountdownSnapshot = async (db: D1Database, channelId: string): Promise<AdCountdownSnapshot | null> => {
  const row = await db.prepare(
    "SELECT next_ad_at, duration, snooze_count, snooze_refresh_at FROM ads_countdown_state WHERE channel_id = ?",
  ).bind(channelId).first<AdCountdownRow>();
  return row === null ? null : {
    nextAdAt: row.next_ad_at,
    duration: row.duration,
    snoozeCount: row.snooze_count,
    snoozeRefreshAt: row.snooze_refresh_at,
  };
};

export const readAdCountdownState = async (
  db: D1Database,
  channelId: string,
  serverNow = new Date().toISOString(),
): Promise<AdCountdownState> => {
  const snapshot = await readAdCountdownSnapshot(db, channelId);
  return {
    nextAdAt: snapshot?.nextAdAt ?? null,
    duration: snapshot?.duration ?? null,
    snoozeCount: snapshot?.snoozeCount ?? null,
    snoozeRefreshAt: snapshot?.snoozeRefreshAt ?? null,
    serverNow,
  };
};

/** Mirrors only schedule changes needed to hydrate overlays; the browser owns countdown ticks. */
export const writeAdCountdownState = async (
  db: D1Database,
  channelId: string,
  state: AdCountdownState,
  updatedAt: string,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO ads_countdown_state (channel_id, next_ad_at, duration, snooze_count, snooze_refresh_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       next_ad_at = excluded.next_ad_at,
       duration = excluded.duration,
       snooze_count = excluded.snooze_count,
       snooze_refresh_at = excluded.snooze_refresh_at,
       updated_at = excluded.updated_at`,
  ).bind(channelId, state.nextAdAt, state.duration, state.snoozeCount, state.snoozeRefreshAt, updatedAt).run();
};
