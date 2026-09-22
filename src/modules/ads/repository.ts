import type { LetzteWerbepause } from "./contracts";

interface WerbeereignisZeile {
  created_at: string;
  detail_json: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dauer = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export const listeLetzteWerbepausen = async (
  db: D1Database,
  channelId: string,
  limit = 5,
): Promise<LetzteWerbepause[]> => {
  const result = await db.prepare(
    `SELECT created_at, detail_json
       FROM event_log
      WHERE channel_id = ?
        AND module_id = 'ads'
        AND code = 'ads.ankuendigung'
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?`,
  ).bind(channelId, limit).all<WerbeereignisZeile>();

  return result.results.flatMap((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.detail_json);
    } catch {
      return [];
    }
    if (!record(parsed)) return [];
    const duration = dauer(parsed.dauer);
    if (duration === null) return [];
    const startedAt = typeof parsed.gestartet === "string" && parsed.gestartet.length > 0
      ? parsed.gestartet
      : row.created_at;
    return [{ zeitpunkt: startedAt, dauerSekunden: duration }];
  });
};
