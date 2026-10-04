import type { Votekick, VotekickStatus } from "../contracts";
import type { VotekickAdmissionResult, VotekickRepository } from "../repository";

interface VotekickRow {
  votekick_id: string;
  target_user_id: string | null;
  target_login: string | null;
  initiator_user_id: string | null;
  status: VotekickStatus;
  threshold: number;
  yes_votes: number;
  no_votes: number;
  ballot_revision: number;
  duration_seconds: number | null;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  lifted_at: string | null;
}

const mapRow = (row: VotekickRow): Votekick => ({
  id: row.votekick_id,
  targetUserId: row.target_user_id,
  targetLogin: row.target_login,
  initiatorUserId: row.initiator_user_id,
  status: row.status,
  threshold: row.threshold,
  yesVotes: row.yes_votes,
  noVotes: row.no_votes,
  ballotRevision: row.ballot_revision,
  durationSeconds: row.duration_seconds,
  startedAt: row.started_at,
  endsAt: row.expires_at,
  endedAt: row.ended_at,
  liftedAt: row.lifted_at,
});

const rowColumns = `votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
  yes_votes, no_votes, ballot_revision, duration_seconds, started_at, expires_at, ended_at, lifted_at`;

export const createVotekickRepository = (db: D1Database): VotekickRepository => ({
  async admit(channelId, input, checkedAt, channelCooldownSeconds, targetCooldownSeconds): Promise<VotekickAdmissionResult> {
    const channelCutoff = new Date(Date.parse(checkedAt) - channelCooldownSeconds * 1000).toISOString();
    const targetCutoff = new Date(Date.parse(checkedAt) - targetCooldownSeconds * 1000).toISOString();
    const results = await db.batch([
      db.prepare(
        `UPDATE votekicks SET status = 'expired', ended_at = expires_at
          WHERE channel_id = ? AND status = 'running' AND expires_at <= ?`,
      ).bind(channelId, checkedAt),
      db.prepare(
        `INSERT OR IGNORE INTO votekicks
          (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
           yes_votes, no_votes, ballot_revision, duration_seconds, started_at, expires_at, ended_at, lifted_at)
         SELECT ?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, NULL, ?, ?, NULL, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM votekicks WHERE channel_id = ? AND status = 'running'
          )
            AND NOT EXISTS (
              SELECT 1 FROM votekicks WHERE channel_id = ? AND ended_at > ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM votekicks WHERE channel_id = ? AND target_user_id = ? AND started_at > ?
            )`,
      ).bind(channelId, input.id, input.targetUserId, input.targetLogin, input.initiatorUserId, input.threshold,
        input.yesVotes, input.ballotRevision, input.startedAt, input.endsAt, channelId, channelId, channelCutoff,
        channelId, input.targetUserId, targetCutoff),
      db.prepare(
        `SELECT CASE
          WHEN EXISTS (SELECT 1 FROM votekicks WHERE channel_id = ? AND status = 'running') THEN 'busy'
          WHEN EXISTS (SELECT 1 FROM votekicks WHERE channel_id = ? AND ended_at > ?) THEN 'channel_cooldown'
          WHEN EXISTS (SELECT 1 FROM votekicks WHERE channel_id = ? AND target_user_id = ? AND started_at > ?) THEN 'target_cooldown'
          ELSE 'busy'
        END AS reason`,
      ).bind(channelId, channelId, channelCutoff, channelId, input.targetUserId, targetCutoff),
    ]);
    if ((results[1]?.meta.changes ?? 0) > 0) return "admitted";
    const reason = (results[2]?.results[0] as { reason?: unknown } | undefined)?.reason;
    return reason === "channel_cooldown" || reason === "target_cooldown" ? reason : "busy";
  },

  async expireOverdue(channelId, now): Promise<readonly Votekick[]> {
    const result = await db.prepare(
      `UPDATE votekicks SET status = 'expired', ended_at = expires_at
        WHERE channel_id = ? AND status = 'running' AND expires_at <= ?
        RETURNING ${rowColumns}`,
    ).bind(channelId, now).all<VotekickRow>();
    return result.results.map(mapRow);
  },

  async byId(channelId, id): Promise<Votekick | null> {
    const row = await db.prepare(
      `SELECT ${rowColumns} FROM votekicks WHERE channel_id = ? AND votekick_id = ?`,
    ).bind(channelId, id).first<VotekickRow>();
    return row === null ? null : mapRow(row);
  },

  async running(channelId): Promise<Votekick | null> {
    const row = await db.prepare(
      `SELECT ${rowColumns} FROM votekicks WHERE channel_id = ? AND status = 'running' LIMIT 1`,
    ).bind(channelId).first<VotekickRow>();
    return row === null ? null : mapRow(row);
  },

  async listRecent(channelId, since): Promise<readonly Votekick[]> {
    const result = await db.prepare(
      `SELECT ${rowColumns} FROM votekicks
        WHERE channel_id = ? AND started_at >= ?
        ORDER BY started_at DESC, votekick_id DESC LIMIT 100`,
    ).bind(channelId, since).all<VotekickRow>();
    return result.results.map(mapRow);
  },

  async updateCounts(channelId, id, yesVotes, noVotes, ballotRevision): Promise<void> {
    await db.prepare(
      `UPDATE votekicks SET yes_votes = ?, no_votes = ?, ballot_revision = ?
        WHERE channel_id = ? AND votekick_id = ? AND status IN ('running', 'expired') AND ballot_revision < ?`,
    ).bind(yesVotes, noVotes, ballotRevision, channelId, id, ballotRevision).run();
  },

  async finish(channelId, id, status: Exclude<VotekickStatus, "running">, yesVotes, noVotes, ballotRevision, durationSeconds, endedAt): Promise<boolean> {
    const result = await db.prepare(
      `UPDATE votekicks
          SET status = ?,
              yes_votes = CASE WHEN ? IS NOT NULL AND ballot_revision < ? THEN ? ELSE yes_votes END,
              no_votes = CASE WHEN ? IS NOT NULL AND ballot_revision < ? THEN ? ELSE no_votes END,
              ballot_revision = CASE WHEN ? IS NOT NULL AND ballot_revision < ? THEN ? ELSE ballot_revision END,
              duration_seconds = ?, ended_at = ?
        WHERE channel_id = ? AND votekick_id = ? AND status = 'running'
          AND (? <> 'passed' OR ballot_revision <= ?)`,
    ).bind(status, ballotRevision, ballotRevision, yesVotes, ballotRevision, ballotRevision, noVotes,
      ballotRevision, ballotRevision, ballotRevision, durationSeconds, endedAt, channelId, id, status, ballotRevision).run();
    return result.meta.changes > 0;
  },

  async cancel(channelId, id, now): Promise<Votekick | null> {
    const row = await db.prepare(
      `SELECT ${rowColumns} FROM votekicks WHERE channel_id = ? AND votekick_id = ? AND status = 'running'`,
    ).bind(channelId, id).first<VotekickRow>();
    if (row === null) return null;
    const result = await db.prepare(
      `UPDATE votekicks SET status = 'cancelled', ended_at = ?
        WHERE channel_id = ? AND votekick_id = ? AND status = 'running'`,
    ).bind(now, channelId, id).run();
    return result.meta.changes === 0 ? null : { ...mapRow(row), status: "cancelled", endedAt: now };
  },

  async markLifted(channelId, id, now): Promise<boolean> {
    const result = await db.prepare(
      `UPDATE votekicks SET lifted_at = ?
        WHERE channel_id = ? AND votekick_id = ? AND status = 'passed' AND lifted_at IS NULL AND target_user_id IS NOT NULL`,
    ).bind(now, channelId, id).run();
    return result.meta.changes > 0;
  },
});

export const purgeExpiredVotekickUserIds = async (db: D1Database, now: string): Promise<void> => {
  const cutoff = new Date(Date.parse(now) - 14 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(
    `UPDATE votekicks SET target_user_id = NULL, target_login = NULL, initiator_user_id = NULL
      WHERE started_at < ? AND (target_user_id IS NOT NULL OR target_login IS NOT NULL OR initiator_user_id IS NOT NULL)`,
  ).bind(cutoff).run();
};
