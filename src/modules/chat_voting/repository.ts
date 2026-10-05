import type { ModuleMutationAuthorization } from "../contract";
import type { ChatVote, ChatVoteCloseReason, ChatVoteDraft, ChatVotingPreset } from "./contracts";

interface ChatVoteRow {
  channel_id: string;
  poll_id: string;
  preset: ChatVotingPreset;
  option_count: number;
  labels_json: string;
  status: "open" | "closed";
  opened_at: string;
  closes_at: string;
  requested_duration_seconds: number | null;
  closed_at: string | null;
  close_reason: ChatVoteCloseReason;
  counts_json: string | null;
  voter_count: number | null;
}

const parseStringArray = (value: string | null): string[] | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch { return null; }
};

const parseNumberArray = (value: string | null): number[] | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(item) && item >= 0) ? parsed : null;
  } catch { return null; }
};

const mapRow = (row: ChatVoteRow): ChatVote => ({
  id: row.poll_id,
  channelId: row.channel_id,
  preset: row.preset,
  optionCount: row.option_count,
  labels: parseStringArray(row.labels_json) ?? [],
  status: row.status,
  openedAt: row.opened_at,
  closesAt: row.closes_at,
  requestedDurationSeconds: row.requested_duration_seconds,
  closedAt: row.closed_at,
  closeReason: row.close_reason,
  counts: parseNumberArray(row.counts_json),
  voterCount: row.voter_count,
});

export const chatVoteSelectColumns = `channel_id, poll_id, preset, option_count, labels_json, status,
                                      opened_at, closes_at, requested_duration_seconds, closed_at,
                                      close_reason, counts_json, voter_count`;

export interface ChatVotingRepository {
  open(channelId: string): Promise<ChatVote | null>;
  latest(channelId: string): Promise<ChatVote | null>;
  byId(channelId: string, pollId: string): Promise<ChatVote | null>;
  insertOpen(vote: ChatVoteDraft, authorization?: ModuleMutationAuthorization): Promise<boolean>;
  requestManualClose(channelId: string, pollId: string, authorization?: ModuleMutationAuthorization): Promise<boolean>;
  finish(channelId: string, pollId: string, closeReason: ChatVoteCloseReason, closedAt: string, counts: readonly number[]): Promise<boolean>;
}

export const createChatVotingRepository = (db: D1Database): ChatVotingRepository => ({
  async open(channelId) {
    const row = await db.prepare(
      `SELECT ${chatVoteSelectColumns} FROM chat_votes WHERE channel_id = ? AND status = 'open' LIMIT 1`,
    ).bind(channelId).first<ChatVoteRow>();
    return row === null ? null : mapRow(row);
  },
  async latest(channelId) {
    const row = await db.prepare(
      `SELECT ${chatVoteSelectColumns} FROM chat_votes WHERE channel_id = ?
        ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, opened_at DESC LIMIT 1`,
    ).bind(channelId).first<ChatVoteRow>();
    return row === null ? null : mapRow(row);
  },
  async byId(channelId, pollId) {
    const row = await db.prepare(
      `SELECT ${chatVoteSelectColumns} FROM chat_votes WHERE channel_id = ? AND poll_id = ? LIMIT 1`,
    ).bind(channelId, pollId).first<ChatVoteRow>();
    return row === null ? null : mapRow(row);
  },
  async insertOpen(vote, authorization) {
    const guard = authorization?.sql ?? "";
    const statement = db.prepare(
      `INSERT INTO chat_votes
         (channel_id, poll_id, preset, option_count, labels_json, status, opened_at, closes_at,
          requested_duration_seconds, close_reason)
       SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ?, ? WHERE 1 = 1 ${guard}`,
    ).bind(
      vote.channelId,
      vote.id,
      vote.preset,
      vote.optionCount,
      JSON.stringify(vote.labels),
      vote.openedAt,
      vote.closesAt,
      vote.requestedDurationSeconds,
      vote.closeReason,
      ...(authorization?.values ?? []),
    );
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async requestManualClose(channelId, pollId, authorization) {
    const guard = authorization?.sql ?? "";
    const statement = db.prepare(
      `UPDATE chat_votes
          SET close_reason = 'manual'
        WHERE channel_id = ? AND poll_id = ? AND status = 'open'
          AND close_reason IN ('timer', 'limit', 'manual') ${guard}`,
    ).bind(channelId, pollId, ...(authorization?.values ?? []));
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async finish(channelId, pollId, closeReason, closedAt, counts) {
    const statement = db.prepare(
      `UPDATE chat_votes
          SET status = 'closed', closed_at = ?, close_reason = ?, counts_json = ?, voter_count = ?
        WHERE channel_id = ? AND poll_id = ? AND status = 'open'`,
    ).bind(closedAt, closeReason, JSON.stringify(counts), counts.reduce((sum, count) => sum + count, 0), channelId, pollId);
    const result = await statement.run();
    return result.meta.changes > 0;
  },
});
