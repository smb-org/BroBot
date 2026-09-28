import type { ApiSource } from "../contracts";

interface ApiSourceRow {
  source_name: string;
  url: string;
  expression: string;
  revision: number;
  updated_at: string;
}

const mapSource = (row: ApiSourceRow): ApiSource => ({
  name: row.source_name,
  url: row.url,
  expression: row.expression,
  revision: row.revision,
  updatedAt: row.updated_at,
});

export const listApiSources = async (db: D1Database, channelId: string): Promise<readonly ApiSource[]> => {
  const result = await db.prepare(
    `SELECT source_name, url, expression, revision, updated_at
       FROM api_sources WHERE channel_id = ? ORDER BY source_name`,
  ).bind(channelId).all<ApiSourceRow>();
  return result.results.map(mapSource);
};

export const getApiSource = async (db: D1Database, channelId: string, name: string): Promise<ApiSource | null> => {
  const row = await db.prepare(
    `SELECT source_name, url, expression, revision, updated_at
       FROM api_sources WHERE channel_id = ? AND source_name = ?`,
  ).bind(channelId, name).first<ApiSourceRow>();
  return row === null ? null : mapSource(row);
};

export const readCachedApiPayload = async (
  db: D1Database,
  urlHash: string,
  now: number,
): Promise<{ payload: unknown } | null> => {
  const row = await db.prepare(
    "SELECT payload_json, expires_at FROM api_source_cache WHERE url_hash = ?",
  ).bind(urlHash).first<{ payload_json: string; expires_at: string }>();
  if (row === null || Date.parse(row.expires_at) <= now) return null;
  try {
    return { payload: JSON.parse(row.payload_json) as unknown };
  } catch {
    return null;
  }
};

export const storeCachedApiPayload = async (
  db: D1Database,
  urlHash: string,
  payload: unknown,
  expiresAt: number,
  now: number,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO api_source_cache (url_hash, payload_json, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(url_hash) DO UPDATE SET payload_json = excluded.payload_json,
       expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
  ).bind(urlHash, JSON.stringify(payload), new Date(expiresAt).toISOString(), new Date(now).toISOString()).run();
};

export const claimApiSourceQuota = async (
  db: D1Database,
  channelId: string,
  now: number,
  maximum: number,
): Promise<boolean> => {
  const hour = Math.floor(now / 3_600_000) * 3_600_000;
  const windowStart = new Date(hour).toISOString();
  const row = await db.prepare(
    `INSERT INTO api_source_quota (channel_id, window_start, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(channel_id, window_start) DO UPDATE SET request_count = request_count + 1
       WHERE request_count < ?
     RETURNING request_count`,
  ).bind(channelId, windowStart, maximum).first<{ request_count: number }>();
  await db.prepare("DELETE FROM api_source_quota WHERE window_start < ?")
    .bind(new Date(hour - 48 * 3_600_000).toISOString()).run();
  return row !== null;
};
