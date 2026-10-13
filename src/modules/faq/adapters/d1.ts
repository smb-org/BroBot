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
  answer_text: string;
  cooldown_seconds: number;
  user_cooldown_seconds: number;
  games_json: string;
  chat_target: Exclude<FaqEntry["chatTarget"], null>;
  use_channel_default_target: number;
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
  answerText: row.answer_text,
  cooldownSeconds: row.cooldown_seconds,
  userCooldownSeconds: row.user_cooldown_seconds,
  games: gamesFrom(row.games_json),
  chatTarget: row.use_channel_default_target === 1 ? null : row.chat_target,
  order: row.sort_order,
  revision: row.revision,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectFaqEntries = `SELECT faq_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds, user_cooldown_seconds,
                                 games_json, chat_target, use_channel_default_target, sort_order, revision, last_used_at, created_at, updated_at
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
  async claim(channelId, entry, userId, now): Promise<FaqClaimResult> {
    const claimEntry = db.prepare(
      `UPDATE faq_entries
          SET last_used_at = ?
        WHERE channel_id = ? AND faq_id = ? AND enabled = 1 AND revision = ?
          AND matcher_type = ?
          AND (last_used_at IS NULL OR
               julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)
          AND (? IS NULL OR user_cooldown_seconds = 0 OR NOT EXISTS (
            SELECT 1 FROM faq_entry_user_cooldowns AS user_cooldown
             WHERE user_cooldown.channel_id = faq_entries.channel_id
               AND user_cooldown.faq_id = faq_entries.faq_id
               AND user_cooldown.user_id = ?
               AND julianday(user_cooldown.last_used_at) >
                   julianday(?) - faq_entries.user_cooldown_seconds / 86400.0
          ))`,
    ).bind(now, channelId, entry.id, entry.revision, entry.matcher.type, now, userId, userId, now);
    let changes: number;
    if (userId !== null && entry.userCooldownSeconds > 0) {
      const claimPerson = db.prepare(
        `INSERT INTO faq_entry_user_cooldowns (channel_id, faq_id, user_id, last_used_at)
         SELECT faq.channel_id, faq.faq_id, ?, ?
           FROM faq_entries AS faq
          WHERE faq.channel_id = ? AND faq.faq_id = ? AND faq.revision = ?
            AND faq.enabled = 1 AND faq.user_cooldown_seconds > 0 AND faq.last_used_at = ?
            AND changes() = 1
         ON CONFLICT (channel_id, faq_id, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      ).bind(userId, now, channelId, entry.id, entry.revision, now);
      const [result] = await db.batch([claimEntry, claimPerson]);
      changes = result?.meta.changes ?? 0;
    } else {
      changes = (await claimEntry.run()).meta.changes;
    }
    if (changes > 0) return { claimed: true, claimedAt: now };
    const current = await db.prepare(
      "SELECT last_used_at, cooldown_seconds, user_cooldown_seconds, enabled, revision FROM faq_entries WHERE channel_id = ? AND faq_id = ?",
    ).bind(channelId, entry.id).first<{
      last_used_at: string | null;
      cooldown_seconds: number;
      user_cooldown_seconds: number;
      enabled: number;
      revision: number;
    }>();
    if (current === null || current.enabled !== 1 || current.revision !== entry.revision) return { claimed: false, reason: "changed" };
    const userCooldown = userId === null || current.user_cooldown_seconds === 0
      ? null
      : await db.prepare(
        "SELECT last_used_at FROM faq_entry_user_cooldowns WHERE channel_id = ? AND faq_id = ? AND user_id = ?",
      ).bind(channelId, entry.id, userId).first<{ last_used_at: string }>();
    const personRemainingSeconds = remainingCooldown(
      userCooldown?.last_used_at ?? null,
      now,
      current.user_cooldown_seconds,
    );
    if (personRemainingSeconds > 0) {
      return { claimed: false, reason: "person_cooldown", remainingSeconds: personRemainingSeconds };
    }
    return {
      claimed: false,
      reason: "cooldown",
      remainingSeconds: remainingCooldown(current.last_used_at, now, current.cooldown_seconds),
    };
  },
  async releaseClaim(channelId, entry, userId, claimedAt) {
    const releaseEntry = db.prepare(
      `UPDATE faq_entries
          SET last_used_at = ?
        WHERE channel_id = ? AND faq_id = ? AND last_used_at = ?`,
    ).bind(entry.lastUsedAt, channelId, entry.id, claimedAt);
    if (userId === null || entry.userCooldownSeconds === 0) {
      await releaseEntry.run();
      return;
    }
    const releasePerson = db.prepare(
      `DELETE FROM faq_entry_user_cooldowns
        WHERE channel_id = ? AND faq_id = ? AND user_id = ? AND last_used_at = ?`,
    ).bind(channelId, entry.id, userId, claimedAt);
    await db.batch([releaseEntry, releasePerson]);
  },
  invalidate(channelId) {
    cacheByDatabase.get(db)?.delete(channelId);
  },
});

export const purgeExpiredFaqUserCooldowns = async (db: D1Database, now: string): Promise<void> => {
  const cutoff = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM faq_entry_user_cooldowns WHERE last_used_at < ?").bind(cutoff).run();
};
