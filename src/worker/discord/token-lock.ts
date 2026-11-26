import { DiscordRequestError, discordApiRequest, type DiscordEnvironment } from "../../modules/discord/adapters/discord";

export interface DiscordBotTokenLock {
  lockedAt: string;
  lastProbeAt: string;
}

export const readDiscordBotTokenLock = async (db: D1Database): Promise<DiscordBotTokenLock | null> =>
  await db.prepare(
    "SELECT locked_at AS lockedAt, last_probe_at AS lastProbeAt FROM discord_bot_token_lock WHERE singleton = 1",
  ).first<DiscordBotTokenLock>();

export const setDiscordBotTokenLock = async (db: D1Database, at: string): Promise<boolean> => {
  const result = await db.prepare(
    "INSERT OR IGNORE INTO discord_bot_token_lock (singleton, locked_at, last_probe_at, probe_token, probe_until) VALUES (1, ?, ?, NULL, NULL)",
  ).bind(at, at).run();
  return result.meta.changes > 0;
};

export const claimDiscordBotTokenProbe = async (
  db: D1Database,
  expectedLastProbeAt: string,
  at: string,
  token: string,
  probeUntil: string,
  now: string,
  dueBy?: string,
): Promise<boolean> => {
  const result = dueBy === undefined
    ? await db.prepare(
      `UPDATE discord_bot_token_lock SET last_probe_at = ?, probe_token = ?, probe_until = ?
        WHERE singleton = 1 AND last_probe_at = ? AND (probe_until IS NULL OR probe_until <= ?)`,
    ).bind(at, token, probeUntil, expectedLastProbeAt, now).run()
    : await db.prepare(
      `UPDATE discord_bot_token_lock SET last_probe_at = ?, probe_token = ?, probe_until = ?
        WHERE singleton = 1 AND last_probe_at = ? AND last_probe_at <= ? AND (probe_until IS NULL OR probe_until <= ?)`,
    ).bind(at, token, probeUntil, expectedLastProbeAt, dueBy, now).run();
  return result.meta.changes > 0;
};

export const deferDiscordBotTokenProbe = async (db: D1Database, claimedAt: string, token: string, retryAt: string): Promise<void> => {
  await db.prepare(
    `UPDATE discord_bot_token_lock SET last_probe_at = ?, probe_token = NULL, probe_until = ?
      WHERE singleton = 1 AND last_probe_at = ? AND probe_token = ?`,
  ).bind(new Date(Date.parse(retryAt) - 60 * 60_000).toISOString(), retryAt, claimedAt, token).run();
};

export const releaseDiscordBotTokenProbe = async (db: D1Database, claimedAt: string, token: string): Promise<void> => {
  await db.prepare(
    `UPDATE discord_bot_token_lock SET probe_token = NULL, probe_until = NULL
      WHERE singleton = 1 AND last_probe_at = ? AND probe_token = ?`,
  ).bind(claimedAt, token).run();
};

export const clearDiscordBotTokenLock = async (db: D1Database): Promise<boolean> => {
  const result = await db.prepare("DELETE FROM discord_bot_token_lock WHERE singleton = 1").run();
  return result.meta.changes > 0;
};

export const clearClaimedDiscordBotTokenLock = async (db: D1Database, claimedAt: string, token: string): Promise<boolean> => {
  const result = await db.prepare("DELETE FROM discord_bot_token_lock WHERE singleton = 1 AND last_probe_at = ? AND probe_token = ?").bind(claimedAt, token).run();
  return result.meta.changes > 0;
};

export const probeDiscordBotToken = async (
  environment: DiscordEnvironment,
  db: D1Database,
  now = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; wasLocked: boolean; probed: boolean }> => {
  const previous = await readDiscordBotTokenLock(db);
  if (previous === null) return { ok: false, wasLocked: false, probed: false };
  const claimedAt = new Date(Math.max(Date.parse(now), Date.parse(previous.lastProbeAt) + 1)).toISOString();
  const token = crypto.randomUUID();
  if (!await claimDiscordBotTokenProbe(db, previous.lastProbeAt, claimedAt, token,
    new Date(Date.parse(now) + 30_000).toISOString(), now)) return { ok: false, wasLocked: true, probed: false };
  try {
    await discordApiRequest(environment, "GET", "/users/@me", undefined, undefined, fetcher);
    return { ok: true, wasLocked: await clearClaimedDiscordBotTokenLock(db, claimedAt, token), probed: true };
  } catch (error) {
    // Keep the hour cadence while preserving Discord's exact retry deadline as a claim lease.
    if (error instanceof DiscordRequestError && error.status === 429) {
      const retryAt = new Date(Date.now() + (error.retryAfterSeconds ?? 1) * 1_000).toISOString();
      await deferDiscordBotTokenProbe(db, claimedAt, token, retryAt);
    } else {
      await releaseDiscordBotTokenProbe(db, claimedAt, token);
    }
    return { ok: false, wasLocked: true, probed: true };
  }
};
