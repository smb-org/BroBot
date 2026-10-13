export interface TwitchGameCategory {
  id: string;
  name: string;
  boxArtUrlTemplate?: string;
}

interface CachedGameListRow {
  games_json: string;
  expires_at_ms: number;
}

interface RecentChannelGameRow {
  game_id: string;
  game_name: string;
}

const GAME_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const parseCachedGames = (value: string): TwitchGameCategory[] | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((entry): TwitchGameCategory[] => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.name !== "string") return [];
      return [{
        id: record.id,
        name: record.name,
        ...(typeof record.boxArtUrlTemplate === "string" ? { boxArtUrlTemplate: record.boxArtUrlTemplate } : {}),
      }];
    });
  } catch {
    return null;
  }
};

export const readCachedGameList = async (
  database: D1Database,
  cacheKey: string,
  now: number,
): Promise<TwitchGameCategory[] | null> => {
  const row = await database.prepare(
    `SELECT games_json, expires_at_ms
       FROM twitch_game_search_cache
      WHERE cache_key = ? AND expires_at_ms > ?`,
  ).bind(cacheKey, now).first<CachedGameListRow>();
  return row === null ? null : parseCachedGames(row.games_json);
};

export const writeCachedGameList = async (
  database: D1Database,
  cacheKey: string,
  games: readonly TwitchGameCategory[],
  now: number,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_game_search_cache (cache_key, games_json, expires_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET
       games_json = excluded.games_json,
       expires_at_ms = excluded.expires_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(cacheKey, JSON.stringify(games), now + GAME_SEARCH_CACHE_TTL_MS, now).run();
};

export const recordChannelGameHistory = async (
  database: D1Database,
  channelId: string,
  gameId: string,
  gameName: string,
  streamedAt: string,
): Promise<void> => {
  const name = gameName.trim().slice(0, 100);
  const timestamp = Date.parse(streamedAt);
  if (!/^\d{1,20}$/u.test(gameId) || name.length === 0 || !Number.isSafeInteger(timestamp) || timestamp < 0) return;

  await database.prepare(
    `INSERT INTO channel_game_history (channel_id, game_id, game_name, last_seen_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (channel_id, game_id) DO UPDATE SET
       game_name = CASE WHEN excluded.last_seen_at_ms >= channel_game_history.last_seen_at_ms
                        THEN excluded.game_name ELSE channel_game_history.game_name END,
       last_seen_at_ms = MAX(channel_game_history.last_seen_at_ms, excluded.last_seen_at_ms)`,
  ).bind(channelId, gameId, name, timestamp).run();
  await database.prepare(
    `DELETE FROM channel_game_history
      WHERE channel_id = ?
        AND game_id NOT IN (
          SELECT game_id FROM channel_game_history
           WHERE channel_id = ? ORDER BY last_seen_at_ms DESC LIMIT 20
        )`,
  ).bind(channelId, channelId).run();
};

export const readRecentChannelGames = async (
  database: D1Database,
  channelId: string,
  limit = 9,
): Promise<TwitchGameCategory[]> => {
  const rows = await database.prepare(
    `SELECT game_id, game_name FROM channel_game_history
      WHERE channel_id = ? ORDER BY last_seen_at_ms DESC, game_id LIMIT ?`,
  ).bind(channelId, limit).all<RecentChannelGameRow>();
  return rows.results.map((row) => ({ id: row.game_id, name: row.game_name }));
};
