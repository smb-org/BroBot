import type { Votekick, VotekickStatus } from "../contracts";
import type { VotekickRepository, VotekickStart } from "../repository";

interface VotekickRow {
  votekick_id: string;
  target_user_id: string | null;
  target_login: string | null;
  initiator_user_id: string | null;
  status: VotekickStatus;
  threshold: number;
  yes_votes: number;
  no_votes: number;
  duration_seconds: number | null;
  started_at: string;
  ends_at: string;
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
  durationSeconds: row.duration_seconds,
  startedAt: row.started_at,
  endsAt: row.ends_at,
  endedAt: row.ended_at,
  liftedAt: row.lifted_at,
});

const rowColumns = `votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
  yes_votes, no_votes, duration_seconds, started_at, ends_at, ended_at, lifted_at`;

export const createVotekickRepository = (db: D1Database): VotekickRepository => ({
  async channelEndedAt(channelId): Promise<string | null> {
    const row = await db.prepare(
      "SELECT MAX(ended_at) AS last_ended_at FROM votekicks WHERE channel_id = ? AND ended_at IS NOT NULL",
    ).bind(channelId).first<{ last_ended_at: string | null }>();
    return row?.last_ended_at ?? null;
  },

  async targetStartedAt(channelId, targetUserId): Promise<string | null> {
    const row = await db.prepare(
      "SELECT MAX(started_at) AS last_started_at FROM votekicks WHERE channel_id = ? AND target_user_id = ?",
    ).bind(channelId, targetUserId).first<{ last_started_at: string | null }>();
    return row?.last_started_at ?? null;
  },

  async insertRunning(channelId, input: VotekickStart): Promise<boolean> {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO votekicks
        (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
         yes_votes, no_votes, duration_seconds, started_at, ends_at, ended_at, lifted_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, 1, 0, NULL, ?, ?, NULL, NULL)`,
    ).bind(channelId, input.id, input.targetUserId, input.targetLogin, input.initiatorUserId, input.threshold, input.startedAt, input.endsAt).run();
    return result.meta.changes > 0;
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

  async updateCounts(channelId, id, yesVotes, noVotes): Promise<void> {
    await db.prepare(
      `UPDATE votekicks SET yes_votes = ?, no_votes = ?
        WHERE channel_id = ? AND votekick_id = ? AND status = 'running'`,
    ).bind(yesVotes, noVotes, channelId, id).run();
  },

  async finish(channelId, id, status: Exclude<VotekickStatus, "running">, yesVotes, noVotes, durationSeconds, endedAt): Promise<boolean> {
    const result = await db.prepare(
      `UPDATE votekicks
          SET status = ?, yes_votes = ?, no_votes = ?, duration_seconds = ?, ended_at = ?
        WHERE channel_id = ? AND votekick_id = ? AND status = 'running'`,
    ).bind(status, yesVotes, noVotes, durationSeconds, endedAt, channelId, id).run();
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
