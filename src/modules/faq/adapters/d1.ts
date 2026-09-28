import type { FaqEntry, FaqGame, FaqMatcher } from "../contracts";
import type { FaqRepository, FaqClaimResult } from "../repository";
import { prepareFaqMatchers } from "../domain";
import type { PreparedFaqMatcher } from "../domain";

const FAQ_MATCHER_CACHE_TTL_MS = 5_000;
const FAQ_MATCHER_CACHE_CHANNEL_LIMIT = 256;

export interface FaqEntryRow {
  faq_id: string;
  name: string;
  enabled: number;
  matcher_type: string;
  matcher_json: string;
  answer_block: string;
  cooldown_seconds: number;
  games_json: string;
  chat_target: FaqEntry["chatTarget"];
  sort_order: number;
  revision: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CachedMatchers {
  expiresAt: number;
  entries: readonly PreparedFaqMatcher[];
}

const cacheByDatabase = new WeakMap<D1Database, Map<string, CachedMatchers>>();

const jsonValue = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; } catch { return null; }
};

const gamesFrom = (value: string): FaqGame[] => {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const game = item as Record<string, unknown>;
    if (typeof game.id !== "string" || typeof game.name !== "string") return [];
    return [{
      id: game.id,
      name: game.name,
      ...(typeof game.boxArtUrlTemplate === "string" ? { boxArtUrlTemplate: game.boxArtUrlTemplate } : {}),
    }];
  });
};

const matcherFrom = (type: string, value: string): FaqMatcher => {
  const parsed = jsonValue(value);
  if (type === "regex") {
    const storedPattern = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).pattern
      : null;
    const pattern = typeof storedPattern === "string" ? storedPattern : "";
    return { type: "regex", pattern };
  }
  const patterns = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>).patterns)
    ? (parsed as { patterns: unknown[] }).patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  return { type: "keywords", patterns };
};

export const mapFaqEntryRow = (row: FaqEntryRow): FaqEntry => ({
  id: row.faq_id,
  name: row.name,
  enabled: row.enabled === 1,
  matcher: matcherFrom(row.matcher_type, row.matcher_json),
  answerBlock: row.answer_block,
  cooldownSeconds: row.cooldown_seconds,
  games: gamesFrom(row.games_json),
  chatTarget: row.chat_target,
  order: row.sort_order,
  revision: row.revision,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectFaqEntries = `SELECT faq_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
                                 games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at
                            FROM faq_entries
                           WHERE channel_id = ?`;

const remainingCooldown = (lastUsedAt: string | null, now: string, cooldownSeconds: number): number => {
  if (lastUsedAt === null) return 0;
  const elapsed = Date.parse(now) - Date.parse(lastUsedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return cooldownSeconds;
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed / 1000));
};

export const createFaqRepository = (db: D1Database): FaqRepository => ({
  async list(channelId) {
    const result = await db.prepare(`${selectFaqEntries} ORDER BY sort_order, faq_id`)
      .bind(channelId).all<FaqEntryRow>();
    return result.results.map(mapFaqEntryRow);
  },
  async matchers(channelId, now = Date.now()) {
    let channelCache = cacheByDatabase.get(db);
    if (channelCache === undefined) {
      channelCache = new Map();
      cacheByDatabase.set(db, channelCache);
    }
    const cached = channelCache.get(channelId);
    if (cached !== undefined && cached.expiresAt > now) return cached.entries;
    const result = await db.prepare(`${selectFaqEntries} AND enabled = 1 ORDER BY sort_order, faq_id`)
      .bind(channelId).all<FaqEntryRow>();
    const entries = prepareFaqMatchers(result.results.map(mapFaqEntryRow));
    if (channelCache.size >= FAQ_MATCHER_CACHE_CHANNEL_LIMIT) {
      for (const [cachedChannel, value] of channelCache) {
        if (value.expiresAt <= now || channelCache.size >= FAQ_MATCHER_CACHE_CHANNEL_LIMIT) channelCache.delete(cachedChannel);
      }
    }
    channelCache.set(channelId, { expiresAt: now + FAQ_MATCHER_CACHE_TTL_MS, entries });
    return entries;
  },
  async claim(channelId, entry, now): Promise<FaqClaimResult> {
    const result = await db.prepare(
      `UPDATE faq_entries
          SET last_used_at = ?
        WHERE channel_id = ? AND faq_id = ? AND enabled = 1 AND revision = ?
          AND matcher_type = 'keywords'
          AND (last_used_at IS NULL OR
               julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)`,
    ).bind(now, channelId, entry.id, entry.revision, now).run();
    if (result.meta.changes > 0) return { claimed: true, claimedAt: now };
    const current = await db.prepare(
      "SELECT last_used_at, cooldown_seconds, enabled, revision FROM faq_entries WHERE channel_id = ? AND faq_id = ?",
    ).bind(channelId, entry.id).first<{ last_used_at: string | null; cooldown_seconds: number; enabled: number; revision: number }>();
    if (current === null || current.enabled !== 1 || current.revision !== entry.revision) return { claimed: false, reason: "changed" };
    return {
      claimed: false,
      reason: "cooldown",
      remainingSeconds: remainingCooldown(current.last_used_at, now, current.cooldown_seconds),
    };
  },
  async releaseClaim(channelId, entry, claimedAt) {
    await db.prepare(
      `UPDATE faq_entries
          SET last_used_at = ?
        WHERE channel_id = ? AND faq_id = ? AND last_used_at = ?`,
    ).bind(entry.lastUsedAt, channelId, entry.id, claimedAt).run();
  },
  invalidate(channelId) {
    cacheByDatabase.get(db)?.delete(channelId);
  },
});
