import {
  POLLS_ENTRY_MAXIMUM_COUNT,
  pollsEntryInputSchema,
  type PollsEntry,
  type PollsEntryInput,
  type PollsKind,
  type PollsRun,
  type PollsRunChoice,
  type PollsRunStatus,
} from "./contracts";
import type { RunSnapshot } from "./domain/runs";

export interface PollsRepository {
  listEntries(channelId: string): Promise<PollsEntry[]>;
  getEntry(channelId: string, entryId: string): Promise<PollsEntry | null>;
  createEntry(channelId: string, input: PollsEntryInput, now: string): Promise<PollsEntry | "limit_reached">;
  updateEntry(
    channelId: string,
    entryId: string,
    input: PollsEntryInput,
    expectedRevision: number,
    now: string,
  ): Promise<PollsEntry | "not_found" | "conflict">;
  deleteEntry(channelId: string, entryId: string): Promise<boolean>;
  markEntryStarted(channelId: string, entryId: string, now: string): Promise<void>;
  upsertRunSnapshot(channelId: string, snapshot: RunSnapshot): Promise<"inserted" | "updated" | "ignored">;
  listOpenRuns(channelId: string): Promise<PollsRun[]>;
  listRunHistory(
    channelId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ runs: PollsRun[]; nextCursor: string | null }>;
  markRunsUnknown(channelId: string, kind: PollsKind, twitchIds: string[]): Promise<void>;
  findRunByTwitchId(channelId: string, kind: PollsKind, twitchId: string): Promise<PollsRun | null>;
  findRunById(channelId: string, runId: string): Promise<PollsRun | null>;
}

interface EntryRow {
  entry_id: string;
  kind: PollsKind;
  title: string;
  choices_json: string;
  duration_seconds: number;
  channel_points_voting_enabled: number;
  channel_points_per_vote: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
  last_started_at: string | null;
}

interface RunRow {
  run_id: string;
  kind: PollsKind;
  twitch_id: string;
  entry_id: string | null;
  source: "brobot" | "twitch";
  title: string;
  choices_json: string;
  status: PollsRunStatus;
  started_at: string;
  ends_at: string | null;
  locked_at: string | null;
  ended_at: string | null;
  winning_choice_id: string | null;
  last_event_at: string;
}

interface RunCursor {
  startedAt: string;
  runId: string;
}

const parseChoices = (serialized: string): unknown => {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return [];
  }
};

const stringChoices = (serialized: string): string[] => {
  const parsed = parseChoices(serialized);
  return Array.isArray(parsed) ? parsed.filter((choice): choice is string => typeof choice === "string") : [];
};

const runChoices = (serialized: string): PollsRunChoice[] => {
  const parsed = parseChoices(serialized);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((choice): choice is PollsRunChoice => typeof choice === "object" && choice !== null &&
    !Array.isArray(choice) && typeof (choice as Record<string, unknown>).id === "string" &&
    typeof (choice as Record<string, unknown>).title === "string");
};

const mapEntry = (row: EntryRow): PollsEntry => {
  const parsed = pollsEntryInputSchema.parse({
    kind: row.kind,
    title: row.title,
    choices: stringChoices(row.choices_json),
    durationSeconds: row.duration_seconds,
    channelPointsVotingEnabled: row.channel_points_voting_enabled === 1,
    channelPointsPerVote: row.channel_points_per_vote,
  });
  return {
    ...parsed,
    id: row.entry_id,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStartedAt: row.last_started_at,
  };
};

const refundDeadlineFor = (row: RunRow): string | null => {
  if (row.kind !== "prediction" || (row.status !== "active" && row.status !== "locked")) return null;
  const startedAt = Date.parse(row.started_at);
  return Number.isFinite(startedAt) ? new Date(startedAt + 24 * 60 * 60 * 1_000).toISOString() : null;
};

const mapRun = (row: RunRow): PollsRun => ({
  id: row.run_id,
  kind: row.kind,
  twitchId: row.twitch_id,
  entryId: row.entry_id,
  source: row.source,
  title: row.title,
  choices: runChoices(row.choices_json),
  status: row.status,
  startedAt: row.started_at,
  endsAt: row.ends_at,
  lockedAt: row.locked_at,
  endedAt: row.ended_at,
  winningChoiceId: row.winning_choice_id,
  refundDeadline: refundDeadlineFor(row),
  lastEventAt: row.last_event_at,
});

export const entryColumns = `entry_id, kind, title, choices_json, duration_seconds,
  channel_points_voting_enabled, channel_points_per_vote, revision, created_at, updated_at, last_started_at`;

export const runColumns = `run_id, kind, twitch_id, entry_id, source, title, choices_json, status,
  started_at, ends_at, locked_at, ended_at, winning_choice_id, last_event_at`;

const terminalStatus = (kind: PollsKind, status: PollsRunStatus): boolean => kind === "poll"
  ? status === "completed" || status === "terminated" || status === "archived"
  : status === "resolved" || status === "canceled";

export const rankSql =(statusExpression: string): string =>
  `(CASE WHEN ${statusExpression} = 'unknown' THEN -1
    WHEN ${statusExpression} IN ('completed', 'terminated', 'archived', 'resolved', 'canceled') THEN 2
    WHEN ${statusExpression} = 'locked' THEN 1 ELSE 0 END)`;

const encodeCursor = ({ startedAt, runId }: RunCursor): string =>
  btoa(`${startedAt}\n${runId}`).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const decodeCursor = (cursor: string): RunCursor | null => {
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const separator = decoded.indexOf("\n");
    if (separator <= 0 || separator === decoded.length - 1) return null;
    const startedAt = decoded.slice(0, separator);
    const runId = decoded.slice(separator + 1);
    return Number.isFinite(Date.parse(startedAt)) ? { startedAt, runId } : null;
  } catch {
    return null;
  }
};

export const createPollsRepository = (db: D1Database): PollsRepository => ({
  async listEntries(channelId) {
    const result = await db.prepare(
      `SELECT ${entryColumns} FROM polls_entries
        WHERE channel_id = ?
        ORDER BY last_started_at DESC NULLS LAST, updated_at DESC, entry_id ASC`,
    ).bind(channelId).all<EntryRow>();
    return result.results.map(mapEntry);
  },

  async getEntry(channelId, entryId) {
    const row = await db.prepare(
      `SELECT ${entryColumns} FROM polls_entries WHERE channel_id = ? AND entry_id = ?`,
    ).bind(channelId, entryId).first<EntryRow>();
    return row === null ? null : mapEntry(row);
  },

  async createEntry(channelId, input, now) {
    const entryId = crypto.randomUUID();
    const result = await db.prepare(
      `INSERT INTO polls_entries (
         channel_id, entry_id, kind, title, choices_json, duration_seconds,
         channel_points_voting_enabled, channel_points_per_vote, revision, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
        WHERE (SELECT COUNT(*) FROM polls_entries WHERE channel_id = ?) < ?
       RETURNING ${entryColumns}`,
    ).bind(
      channelId, entryId, input.kind, input.title, JSON.stringify(input.choices), input.durationSeconds,
      input.channelPointsVotingEnabled ? 1 : 0, input.channelPointsPerVote, now, now,
      channelId, POLLS_ENTRY_MAXIMUM_COUNT,
    ).all<EntryRow>();
    const row = result.results[0];
    if (row !== undefined) return mapEntry(row);
    return "limit_reached";
  },

  async updateEntry(channelId, entryId, input, expectedRevision, now) {
    const current = await db.prepare(
      `SELECT ${entryColumns} FROM polls_entries WHERE channel_id = ? AND entry_id = ?`,
    ).bind(channelId, entryId).first<EntryRow>();
    if (current === null) return "not_found";
    if (current.kind !== input.kind || current.revision !== expectedRevision) return "conflict";
    const result = await db.prepare(
      `UPDATE polls_entries
          SET title = ?, choices_json = ?, duration_seconds = ?, channel_points_voting_enabled = ?,
              channel_points_per_vote = ?, revision = revision + 1, updated_at = ?
        WHERE channel_id = ? AND entry_id = ? AND kind = ? AND revision = ?
       RETURNING ${entryColumns}`,
    ).bind(
      input.title, JSON.stringify(input.choices), input.durationSeconds,
      input.channelPointsVotingEnabled ? 1 : 0, input.channelPointsPerVote, now,
      channelId, entryId, input.kind, expectedRevision,
    ).all<EntryRow>();
    const updated = result.results[0];
    if (updated !== undefined) return mapEntry(updated);
    const latest = await db.prepare(
      `SELECT ${entryColumns} FROM polls_entries WHERE channel_id = ? AND entry_id = ?`,
    ).bind(channelId, entryId).first<EntryRow>();
    return latest === null ? "not_found" : "conflict";
  },

  async deleteEntry(channelId, entryId) {
    const result = await db.prepare(
      "DELETE FROM polls_entries WHERE channel_id = ? AND entry_id = ?",
    ).bind(channelId, entryId).run();
    return result.meta.changes > 0;
  },

  async markEntryStarted(channelId, entryId, now) {
    await db.prepare(
      "UPDATE polls_entries SET last_started_at = ? WHERE channel_id = ? AND entry_id = ?",
    ).bind(now, channelId, entryId).run();
  },

  async upsertRunSnapshot(channelId, snapshot) {
    const runId = crypto.randomUUID();
    const terminalPayload = terminalStatus(snapshot.kind, snapshot.status) && snapshot.terminalPayload !== null
      ? JSON.stringify(snapshot.terminalPayload)
      : null;
    const mutation = db.prepare(
      `INSERT INTO polls_runs (
         channel_id, run_id, kind, twitch_id, entry_id, source, title, choices_json, status,
         started_at, ends_at, locked_at, ended_at, winning_choice_id, last_event_at, terminal_payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, kind, twitch_id) DO UPDATE SET
         entry_id = COALESCE(polls_runs.entry_id, excluded.entry_id),
         source = CASE
           WHEN polls_runs.source = 'brobot' OR excluded.source = 'brobot' OR excluded.entry_id IS NOT NULL THEN 'brobot'
           ELSE COALESCE(excluded.source, polls_runs.source)
         END,
         title = excluded.title,
         choices_json = excluded.choices_json,
         status = excluded.status,
         started_at = excluded.started_at,
         ends_at = excluded.ends_at,
         locked_at = excluded.locked_at,
         ended_at = excluded.ended_at,
         winning_choice_id = excluded.winning_choice_id,
         last_event_at = excluded.last_event_at,
         terminal_payload_json = CASE
           WHEN excluded.terminal_payload_json IS NOT NULL THEN excluded.terminal_payload_json
           ELSE polls_runs.terminal_payload_json
         END
       WHERE ${rankSql("excluded.status")} > ${rankSql("polls_runs.status")}
          OR (${rankSql("excluded.status")} = ${rankSql("polls_runs.status")}
              AND ${rankSql("excluded.status")} < 2
              AND excluded.last_event_at >= polls_runs.last_event_at)
       RETURNING run_id`,
    ).bind(
      channelId, runId, snapshot.kind, snapshot.twitchId, snapshot.entryId ?? null,
      snapshot.source ?? "twitch", snapshot.title, JSON.stringify(snapshot.choices), snapshot.status,
      snapshot.startedAt, snapshot.endsAt, snapshot.lockedAt, snapshot.endedAt,
      snapshot.winningChoiceId, snapshot.observedAt, terminalPayload,
    );
    const metadata = db.prepare(
      `UPDATE polls_runs
          SET entry_id = COALESCE(entry_id, ?), source = 'brobot'
        WHERE channel_id = ? AND kind = ? AND twitch_id = ?
          AND (? = 'brobot' OR ? IS NOT NULL)`,
    ).bind(
      snapshot.entryId ?? null,
      channelId,
      snapshot.kind,
      snapshot.twitchId,
      snapshot.source ?? "twitch",
      snapshot.entryId ?? null,
    );
    const [mutationResult] = await db.batch([mutation, metadata]);
    const applied = mutationResult?.results[0] as { run_id: string } | undefined;
    if (applied === undefined) return "ignored";
    return applied.run_id === runId ? "inserted" : "updated";
  },

  async listOpenRuns(channelId) {
    const result = await db.prepare(
      `SELECT ${runColumns} FROM polls_runs
        WHERE channel_id = ? AND status IN ('active', 'locked', 'unknown')
        ORDER BY started_at ASC, run_id ASC`,
    ).bind(channelId).all<RunRow>();
    return result.results.map(mapRun);
  },

  async listRunHistory(channelId, cursor, limit) {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    const position = cursor === null ? null : decodeCursor(cursor);
    const result = position === null
      ? await db.prepare(
        `SELECT ${runColumns} FROM polls_runs WHERE channel_id = ?
          ORDER BY started_at DESC, run_id DESC LIMIT ?`,
      ).bind(channelId, boundedLimit + 1).all<RunRow>()
      : await db.prepare(
        `SELECT ${runColumns} FROM polls_runs
          WHERE channel_id = ? AND (started_at < ? OR (started_at = ? AND run_id < ?))
          ORDER BY started_at DESC, run_id DESC LIMIT ?`,
      ).bind(channelId, position.startedAt, position.startedAt, position.runId, boundedLimit + 1).all<RunRow>();
    const hasMore = result.results.length > boundedLimit;
    const page = result.results.slice(0, boundedLimit);
    const last = page[page.length - 1];
    return {
      runs: page.map(mapRun),
      nextCursor: hasMore && last !== undefined ? encodeCursor({ startedAt: last.started_at, runId: last.run_id }) : null,
    };
  },

  async markRunsUnknown(channelId, kind, twitchIds) {
    for (let offset = 0; offset < twitchIds.length; offset += 90) {
      const batch = twitchIds.slice(offset, offset + 90);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      await db.prepare(
        `UPDATE polls_runs SET status = 'unknown'
          WHERE channel_id = ? AND kind = ? AND twitch_id IN (${placeholders})
            AND status IN ('active', 'locked', 'unknown')`,
      ).bind(channelId, kind, ...batch).run();
    }
  },

  async findRunByTwitchId(channelId, kind, twitchId) {
    const row = await db.prepare(
      `SELECT ${runColumns} FROM polls_runs WHERE channel_id = ? AND kind = ? AND twitch_id = ?`,
    ).bind(channelId, kind, twitchId).first<RunRow>();
    return row === null ? null : mapRun(row);
  },

  async findRunById(channelId, runId) {
    const row = await db.prepare(
      `SELECT ${runColumns} FROM polls_runs WHERE channel_id = ? AND run_id = ?`,
    ).bind(channelId, runId).first<RunRow>();
    return row === null ? null : mapRun(row);
  },
});
