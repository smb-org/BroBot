import type { ModuleDiagnostic } from "../modules/contract";

/**
 * Per-channel cap, trimmed once a day (`trimEventLogToLimit`, called from
 * the scheduled handler), not per insert. Measured: a per-insert trim's
 * `LIMIT -1 OFFSET n` walks every row of the channel on every insert (query
 * plan: SEARCH via `event_log_channel_created_idx`, so at this 10000 cap
 * that's 10000 rows stepped per insert). On Cloudflare's free 5M-rows-read/
 * day budget, that trim alone would allow roughly 500 events/day
 * installation-wide before the budget is exhausted. A once-daily trim costs
 * about one day's total row count once, not once per insert.
 */
const EVENT_LOG_LIMIT = 10000;
const EVENT_LOG_RETENTION_DAYS = 14;

/** UTC hour the scheduled handler runs the count trim in, once a day. The
 *  14-day purge (`purgeOldEventLogEntries`) stays on every hourly tick. */
export const EVENT_LOG_DAILY_TRIM_HOUR = 3;

export interface WrittenModuleDiagnostic {
  eventId: string;
  createdAt: string;
  moduleId: string;
  code: string;
  actorUserId: string | null;
}

/**
 * Writes module justifications as well as host-side action and outcome
 * diagnostics. Does not trim -- see `EVENT_LOG_LIMIT`'s comment for why
 * that moved off the insert path.
 */
export const writeModuleDiagnostics = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
  triggerId: string,
  actorUserId: string | null,
  diagnostics: readonly ModuleDiagnostic[],
  now: string,
): Promise<WrittenModuleDiagnostic[]> => {
  if (diagnostics.length === 0) return [];
  const written = diagnostics.map((diagnostic): WrittenModuleDiagnostic => ({
    eventId: crypto.randomUUID(),
    createdAt: now,
    moduleId,
    code: diagnostic.code,
    actorUserId,
  }));
  const inserts = diagnostics.map((diagnostic, index) => db.prepare(
    `INSERT INTO event_log
      (event_id, channel_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    written[index]?.eventId ?? crypto.randomUUID(),
    channelId,
    now,
    moduleId,
    triggerId,
    diagnostic.code,
    JSON.stringify(diagnostic.detail ?? {}),
    actorUserId,
  ));
  await db.batch(inserts);
  return written;
};

/** Deletes events whose creation time is more than 14 days in the past. */
export const purgeOldEventLogEntries = async (db: D1Database, now: string): Promise<void> => {
  const cutoff = new Date(
    Date.parse(now) - EVENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.prepare(
    `DELETE FROM event_log
      WHERE created_at < ?`,
  ).bind(cutoff).run();
};

/**
 * Trims every channel to its newest `EVENT_LOG_LIMIT` rows, in one query
 * across all channels via a window function -- called once a day from the
 * scheduled handler, at `EVENT_LOG_DAILY_TRIM_HOUR`.
 */
export const trimEventLogToLimit = async (db: D1Database): Promise<void> => {
  await db.prepare(
    `DELETE FROM event_log
      WHERE event_id IN (
        SELECT event_id FROM (
          SELECT event_id,
                 ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY created_at DESC, event_id DESC) AS rank
            FROM event_log
        )
       WHERE rank > ?
      )`,
  ).bind(EVENT_LOG_LIMIT).run();
};
