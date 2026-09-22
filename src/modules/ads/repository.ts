import type { LastAdBreak } from "./contracts";

interface AdEventRow {
  created_at: string;
  detail_json: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toDuration = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const listLastAdBreaks = async (
  db: D1Database,
  channelId: string,
  limit = 5,
): Promise<LastAdBreak[]> => {
  const result = await db.prepare(
    `SELECT created_at, detail_json
       FROM event_log
      WHERE channel_id = ?
        AND module_id = 'ads'
        AND code = 'ads.announcement'
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?`,
  ).bind(channelId, limit).all<AdEventRow>();

  return result.results.flatMap((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.detail_json);
    } catch {
      return [];
    }
    if (!record(parsed)) return [];
    const duration = toDuration(parsed.duration);
    if (duration === null) return [];
    // "gestartet" stays: it is the literal wire key ads/service.ts writes into
    // event_log.detail_json for ads.announcement (built via a helper, so it
    // evades the automated frozen-key detector) -- renaming it would orphan
    // the field already stored in production rows.
    const startedAt = typeof parsed.startedAt === "string" && parsed.startedAt.length > 0
      ? parsed.startedAt
      : row.created_at;
    return [{ timestamp: startedAt, durationSeconds: duration }];
  });
};
