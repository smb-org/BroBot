import type { ModuleMutationAuthorization } from "../contract";
import type { ChatVote, ChatVoteCloseReason, ChatVoteDraft, ChatVoteTemplate, ChatVoteTemplateDraft, ChatVoteTerm, ChatVotingKind, ChatVotingTextMode } from "./contracts";

interface ChatVoteRow {
  channel_id: string;
  poll_id: string;
  kind: ChatVotingKind;
  option_count: number;
  labels_json: string;
  title: string | null;
  result_text: string | null;
  text_mode: ChatVotingTextMode | null;
  term_filter_ready: number | null;
  status: "open" | "closed";
  opened_at: string;
  closes_at: string;
  closing_at: string | null;
  deadline_revision: number;
  requested_duration_seconds: number | null;
  closed_at: string | null;
  close_reason: ChatVoteCloseReason;
  counts_json: string | null;
  voter_count: number | null;
  text_results_json: string | null;
  more_terms: number | null;
  result_delivery_pending: number;
}

interface ChatVoteTemplateRow {
  id: string;
  channel_id: string;
  shortcut: string | null;
  title: string;
  result_text: string;
  labels: string;
  free_text_mode: ChatVotingTextMode | null;
  duration_seconds: number;
  revision: number;
  legacy_alias: ChatVoteTemplate["legacyAlias"];
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
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

const isChatVoteTerm = (entry: unknown): entry is ChatVoteTerm => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const term: unknown = Reflect.get(entry, "term");
  const count: unknown = Reflect.get(entry, "count");
  const approved: unknown = Reflect.get(entry, "approved");
  return typeof term === "string" && Array.from(term).length <= 25 &&
    Number.isSafeInteger(count) && (count as number) > 0 && typeof approved === "boolean";
};

const parseTermArray = (value: string | null): ChatVoteTerm[] | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry: unknown) => isChatVoteTerm(entry))
      ? parsed
      : null;
  } catch { return null; }
};

const mapRow = (row: ChatVoteRow): ChatVote => {
  return {
    id: row.poll_id,
    channelId: row.channel_id,
    kind: row.kind,
    optionCount: row.option_count,
    labels: parseStringArray(row.labels_json) ?? [],
    title: row.title,
    resultText: row.result_text,
    textMode: row.text_mode,
    termFilterReady: row.term_filter_ready === null ? null : row.term_filter_ready === 1,
    status: row.status === "closed" ? "closed" : row.closing_at === null ? "open" : "closing",
    openedAt: row.opened_at,
    closesAt: row.closes_at,
    closingAt: row.closing_at,
    deadlineRevision: row.deadline_revision,
    requestedDurationSeconds: row.requested_duration_seconds,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    counts: parseNumberArray(row.counts_json),
    voterCount: row.voter_count,
    textResults: parseTermArray(row.text_results_json),
    moreTerms: row.more_terms,
    resultDeliveryPending: row.result_delivery_pending === 1,
  };
};

const mapTemplateRow = (row: ChatVoteTemplateRow): ChatVoteTemplate => ({
  id: row.id,
  channelId: row.channel_id,
  shortcut: row.shortcut,
  title: row.title,
  resultText: row.result_text,
  labels: parseStringArray(row.labels) ?? [],
  freeTextMode: row.free_text_mode,
  durationSeconds: row.duration_seconds,
  revision: row.revision,
  legacyAlias: row.legacy_alias,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const chatVoteTemplateSelectColumns = `id, channel_id, shortcut, title, result_text, labels, free_text_mode, duration_seconds,
                                             revision, legacy_alias, last_used_at, created_at, updated_at`;

type ChatVoteTemplateWriteStatus = "saved" | "created" | "limit" | "conflict" | "shortcut_conflict" | "missing" | "unauthorized";
type ChatVoteTemplateSaveResult =
  | { status: "saved"; template: ChatVoteTemplate }
  | { status: "shortcut_conflict" }
  | { status: "conflict" }
  | { status: "missing" }
  | { status: "unauthorized" };

export interface ChatVoteTemplateRepository {
  templates(channelId: string): Promise<ChatVoteTemplate[]>;
  template(channelId: string, id: string): Promise<ChatVoteTemplate | null>;
  templateByShortcut(channelId: string, shortcut: string): Promise<ChatVoteTemplate | null>;
  templateByLegacyAlias(channelId: string, alias: NonNullable<ChatVoteTemplate["legacyAlias"]>): Promise<ChatVoteTemplate | null>;
  createTemplate(channelId: string, id: string, draft: ChatVoteTemplateDraft, createdAt: string, authorization: ModuleMutationAuthorization, audit?: D1PreparedStatement): Promise<ChatVoteTemplateWriteStatus>;
  saveTemplate(channelId: string, id: string, revision: number, draft: ChatVoteTemplateDraft, updatedAt: string, authorization: ModuleMutationAuthorization, audit?: D1PreparedStatement): Promise<ChatVoteTemplateSaveResult>;
  deleteTemplate(channelId: string, id: string, revision: number, authorization: ModuleMutationAuthorization, audit?: D1PreparedStatement): Promise<ChatVoteTemplateWriteStatus>;
  markTemplateUsed(channelId: string, id: string, usedAt: string): Promise<void>;
}

export const chatVoteSelectColumns = `channel_id, poll_id, kind, option_count, labels_json, status,
                                      title, result_text, opened_at, closes_at, closing_at, deadline_revision, requested_duration_seconds, closed_at,
                                      close_reason, counts_json, voter_count, text_mode, text_results_json, more_terms,
                                      term_filter_ready, result_delivery_pending`;

export interface ChatVoteResultTextTemplateSnapshot {
  id: string;
  revision: number;
  resultText: string;
}

export interface ChatVotingRepository {
  open(channelId: string): Promise<ChatVote | null>;
  latest(channelId: string): Promise<ChatVote | null>;
  byId(channelId: string, pollId: string): Promise<ChatVote | null>;
  approveTerm(
    channelId: string,
    pollId: string,
    term: string,
    approvedAt: string,
    approvedBy: string,
    authorization: ModuleMutationAuthorization,
  ): Promise<{ authorized: boolean; changed: boolean }>;
  insertOpen(vote: ChatVoteDraft, authorization?: ModuleMutationAuthorization, resultTextTemplate?: ChatVoteResultTextTemplateSnapshot): Promise<boolean>;
  requestManualClose(channelId: string, pollId: string, expectedClosesAt: string, authorization?: ModuleMutationAuthorization): Promise<boolean>;
  claimAlarmClose(channelId: string, pollId: string, expectedClosesAt: string, claimedAt: string): Promise<boolean>;
  extendClose(
    channelId: string,
    pollId: string,
    expectedClosesAt: string,
    closesAt: string,
    authorization?: ModuleMutationAuthorization,
  ): Promise<boolean>;
  rollbackCloseExtension(
    channelId: string,
    pollId: string,
    expectedClosesAt: string,
    expectedDeadlineRevision: number,
    closesAt: string,
  ): Promise<boolean>;
  finish(
    channelId: string,
    pollId: string,
    closeReason: ChatVoteCloseReason,
    closedAt: string,
    counts: readonly number[],
    textResults?: readonly ChatVoteTerm[] | null,
    moreTerms?: number,
    termFilterReady?: boolean | null,
    resultDeliveryPending?: boolean,
  ): Promise<boolean>;
  completeResultDelivery(channelId: string, pollId: string): Promise<boolean>;
  templates: ChatVoteTemplateRepository;
}

const templateRepository = (db: D1Database): ChatVoteTemplateRepository => ({
  async templates(channelId) {
    const result = await db.prepare(
      `SELECT ${chatVoteTemplateSelectColumns} FROM chat_vote_templates WHERE channel_id = ?
        ORDER BY last_used_at DESC, created_at DESC, title COLLATE NOCASE, id`,
    ).bind(channelId).all<ChatVoteTemplateRow>();
    return result.results.map(mapTemplateRow);
  },
  async template(channelId, id) {
    const row = await db.prepare(
      `SELECT ${chatVoteTemplateSelectColumns} FROM chat_vote_templates WHERE channel_id = ? AND id = ? LIMIT 1`,
    ).bind(channelId, id).first<ChatVoteTemplateRow>();
    return row === null ? null : mapTemplateRow(row);
  },
  async templateByShortcut(channelId, shortcut) {
    const row = await db.prepare(
      `SELECT ${chatVoteTemplateSelectColumns} FROM chat_vote_templates WHERE channel_id = ? AND shortcut = ? LIMIT 1`,
    ).bind(channelId, shortcut).first<ChatVoteTemplateRow>();
    return row === null ? null : mapTemplateRow(row);
  },
  async templateByLegacyAlias(channelId, alias) {
    const row = await db.prepare(
      `SELECT ${chatVoteTemplateSelectColumns} FROM chat_vote_templates WHERE channel_id = ? AND legacy_alias = ? LIMIT 1`,
    ).bind(channelId, alias).first<ChatVoteTemplateRow>();
    return row === null ? null : mapTemplateRow(row);
  },
  async createTemplate(channelId, id, draft, createdAt, authorization, audit) {
    const mutation = db.prepare(
      `INSERT INTO chat_vote_templates
         (id, channel_id, shortcut, title, result_text, labels, free_text_mode, duration_seconds, revision,
          legacy_alias, last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?
        WHERE (SELECT COUNT(*) FROM chat_vote_templates WHERE channel_id = ?) < 100
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
          ) ${authorization.sql}
       ON CONFLICT (channel_id, shortcut) WHERE shortcut IS NOT NULL DO NOTHING`,
    ).bind(id, channelId, draft.shortcut, draft.title, draft.resultText ?? "{vote.result}", JSON.stringify(draft.labels), draft.freeTextMode,
      draft.durationSeconds, createdAt, createdAt, channelId, channelId, ...authorization.values);
    const result = audit === undefined ? await mutation.run() : (await db.batch([mutation, audit]))[0];
    if (result === undefined) throw new Error("Template creation mutation returned no D1 result.");
    if (result.meta.changes > 0) return "created";
    const authorized = await db.prepare(
      `SELECT 1 AS authorized WHERE EXISTS (
         SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
       ) ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ authorized: number }>();
    if (authorized === null) return "unauthorized";
    const count = await db.prepare("SELECT COUNT(*) AS count FROM chat_vote_templates WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (count?.count ?? 0) >= 100 ? "limit" : "conflict";
  },
  async saveTemplate(channelId, id, revision, draft, updatedAt, authorization, audit) {
    const existed = await db.prepare(
      "SELECT 1 AS present FROM chat_vote_templates WHERE channel_id = ? AND id = ? LIMIT 1",
    ).bind(channelId, id).first<{ present: number }>() !== null;
    let template: ChatVoteTemplate | null;
    try {
      const mutation = db.prepare(
        `UPDATE chat_vote_templates
            SET shortcut = ?, title = ?, result_text = ?, labels = ?, free_text_mode = ?, duration_seconds = ?,
                revision = revision + 1, updated_at = ?
          WHERE channel_id = ? AND id = ? AND revision = ? ${authorization.sql}
            AND EXISTS (
              SELECT 1 FROM channel_modules
               WHERE channel_modules.channel_id = chat_vote_templates.channel_id
                 AND channel_modules.module_id = 'chat_voting' AND channel_modules.enabled = 1
            )
          RETURNING ${chatVoteTemplateSelectColumns}
        `,
      ).bind(draft.shortcut, draft.title, draft.resultText ?? "{vote.result}", JSON.stringify(draft.labels), draft.freeTextMode,
        draft.durationSeconds, updatedAt, channelId, id, revision, ...authorization.values);
      const result = audit === undefined ? await mutation.run() : (await db.batch([mutation, audit]))[0];
      if (result === undefined) throw new Error("Template save mutation returned no D1 result.");
      const row = result.results[0] as ChatVoteTemplateRow | undefined;
      template = row === undefined ? null : mapTemplateRow(row);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("chat_vote_templates.channel_id, chat_vote_templates.shortcut")) {
        return { status: "shortcut_conflict" };
      }
      throw error;
    }
    if (template !== null) return { status: "saved", template };
    const authorized = await db.prepare(
      `SELECT 1 AS authorized WHERE EXISTS (
         SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
       ) ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ authorized: number }>();
    if (authorized === null) return { status: "unauthorized" };
    return existed ? { status: "conflict" } : { status: "missing" };
  },
  async deleteTemplate(channelId, id, revision, authorization, audit) {
    const mutation = db.prepare(
      `DELETE FROM chat_vote_templates
        WHERE channel_id = ? AND id = ? AND revision = ? ${authorization.sql}
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_modules.channel_id = chat_vote_templates.channel_id
               AND channel_modules.module_id = 'chat_voting' AND channel_modules.enabled = 1
          )`,
    ).bind(channelId, id, revision, ...authorization.values);
    const result = audit === undefined ? await mutation.run() : (await db.batch([mutation, audit]))[0];
    if (result === undefined) throw new Error("Template deletion mutation returned no D1 result.");
    if (result.meta.changes > 0) return "saved";
    const authorized = await db.prepare(
      `SELECT 1 AS authorized WHERE EXISTS (
         SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
       ) ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ authorized: number }>();
    if (authorized === null) return "unauthorized";
    return await this.template(channelId, id) === null ? "missing" : "conflict";
  },
  async markTemplateUsed(channelId, id, usedAt) {
    await db.prepare(
      `UPDATE chat_vote_templates
          SET last_used_at = CASE
            WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
            ELSE last_used_at
          END
        WHERE channel_id = ? AND id = ?`,
    ).bind(usedAt, usedAt, channelId, id).run();
  },
});

export const createChatVotingRepository = (db: D1Database): ChatVotingRepository => ({
  templates: templateRepository(db),
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
  async approveTerm(channelId, pollId, term, approvedAt, approvedBy, authorization) {
    const write = db.prepare(
      `INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM chat_votes
           WHERE channel_id = ? AND poll_id = ? AND status = 'open' AND kind = 'free_text'
        ) AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
        ) ${authorization.sql}
       ON CONFLICT (channel_id, poll_id, term) DO UPDATE SET
         approved_at = excluded.approved_at,
         approved_by = excluded.approved_by`,
    ).bind(channelId, pollId, term, approvedAt, approvedBy, channelId, pollId, channelId, ...authorization.values);
    const guard = db.prepare(
      `SELECT 1 AS authorized WHERE 1 = 1 ${authorization.sql}`,
    ).bind(...authorization.values);
    const [result, guardResult] = await db.batch([write, guard]);
    return {
      authorized: (guardResult?.results.length ?? 0) > 0,
      changed: (result?.meta.changes ?? 0) > 0,
    };
  },
  async insertOpen(vote, authorization, resultTextTemplate) {
    const guard = authorization?.sql ?? "";
    const statement = db.prepare(
      `INSERT INTO chat_votes
         (channel_id, poll_id, kind, option_count, labels_json, title, result_text, text_mode, term_filter_ready, status, opened_at, closes_at,
          requested_duration_seconds, close_reason)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_id = ? AND module_id = 'chat_voting' AND enabled = 1
        ) AND (? IS NULL OR EXISTS (
          SELECT 1 FROM chat_vote_templates
           WHERE channel_id = ? AND id = ? AND revision = ? AND result_text = ?
        )) ${guard}`,
    ).bind(
      vote.channelId,
      vote.id,
      vote.kind,
      vote.optionCount,
      JSON.stringify(vote.labels),
      vote.title,
      vote.resultText ?? null,
      vote.textMode ?? null,
      vote.termFilterReady === null || vote.termFilterReady === undefined ? null : Number(vote.termFilterReady),
      vote.openedAt,
      vote.closesAt,
      vote.requestedDurationSeconds,
      vote.closeReason,
      vote.channelId,
      resultTextTemplate?.id ?? null,
      resultTextTemplate?.id === undefined ? null : vote.channelId,
      resultTextTemplate?.id ?? null,
      resultTextTemplate?.revision ?? null,
      resultTextTemplate?.resultText ?? null,
      ...(authorization?.values ?? []),
    );
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async requestManualClose(channelId, pollId, expectedClosesAt, authorization) {
    const guard = authorization?.sql ?? "";
    const statement = db.prepare(
      `UPDATE chat_votes
          SET close_reason = 'manual',
              closing_at = COALESCE(closing_at, ?),
              deadline_revision = deadline_revision + CASE WHEN closing_at IS NULL THEN 1 ELSE 0 END
        WHERE channel_id = ? AND poll_id = ? AND status = 'open'
          AND closes_at = ? AND close_reason IN ('timer', 'limit', 'manual')
          AND (closing_at IS NULL OR close_reason = 'manual')
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_modules.channel_id = chat_votes.channel_id
               AND channel_modules.module_id = 'chat_voting' AND channel_modules.enabled = 1
          ) ${guard}`,
    ).bind(new Date().toISOString(), channelId, pollId, expectedClosesAt, ...(authorization?.values ?? []));
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async claimAlarmClose(channelId, pollId, expectedClosesAt, claimedAt) {
    const result = await db.prepare(
      `UPDATE chat_votes
          SET closing_at = ?, deadline_revision = deadline_revision + CASE WHEN closing_at IS NULL THEN 1 ELSE 0 END
        WHERE channel_id = ? AND poll_id = ? AND status = 'open' AND closing_at IS NULL
          AND closes_at = ? AND (closes_at <= ? OR close_reason = 'manual')`,
    ).bind(claimedAt, channelId, pollId, expectedClosesAt, claimedAt).run();
    return result.meta.changes > 0;
  },
  async extendClose(channelId, pollId, expectedClosesAt, closesAt, authorization) {
    const guard = authorization?.sql ?? "";
    const statement = db.prepare(
      `UPDATE chat_votes
          SET closes_at = ?, deadline_revision = deadline_revision + 1
        WHERE channel_id = ? AND poll_id = ? AND status = 'open' AND closing_at IS NULL
          AND close_reason <> 'manual' AND closes_at = ?
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_modules.channel_id = chat_votes.channel_id
               AND channel_modules.module_id = 'chat_voting' AND channel_modules.enabled = 1
          ) ${guard}`,
    ).bind(closesAt, channelId, pollId, expectedClosesAt, ...(authorization?.values ?? []));
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async rollbackCloseExtension(channelId, pollId, expectedClosesAt, expectedDeadlineRevision, closesAt) {
    const result = await db.prepare(
      `UPDATE chat_votes
          SET closes_at = ?, deadline_revision = deadline_revision + 1
        WHERE channel_id = ? AND poll_id = ? AND status = 'open' AND closing_at IS NULL
          AND close_reason <> 'manual' AND closes_at = ? AND deadline_revision = ?`,
    ).bind(closesAt, channelId, pollId, expectedClosesAt, expectedDeadlineRevision).run();
    return result.meta.changes > 0;
  },
  async finish(channelId, pollId, closeReason, closedAt, counts, textResults = null, moreTerms = 0, termFilterReady = null, resultDeliveryPending = false) {
    const statement = db.prepare(
      `UPDATE chat_votes
          SET status = 'closed', closed_at = ?, close_reason = ?, counts_json = ?, voter_count = ?,
              text_results_json = ?, more_terms = ?, term_filter_ready = ?, result_delivery_pending = ?
        WHERE channel_id = ? AND poll_id = ? AND status = 'open'`,
    ).bind(
      closedAt,
      closeReason,
      JSON.stringify(counts),
      textResults === null ? counts.reduce((sum, count) => sum + count, 0)
        : textResults.reduce((sum, entry) => sum + entry.count, 0),
      textResults === null ? null : JSON.stringify(textResults),
      textResults === null ? null : moreTerms,
      textResults === null || termFilterReady === null ? null : Number(termFilterReady),
      Number(resultDeliveryPending),
      channelId,
      pollId,
    );
    const result = await statement.run();
    return result.meta.changes > 0;
  },
  async completeResultDelivery(channelId, pollId) {
    const [result] = await db.batch([
      db.prepare(
        `UPDATE chat_votes SET result_delivery_pending = 0
          WHERE channel_id = ? AND poll_id = ? AND status = 'closed' AND result_delivery_pending = 1`,
      ).bind(channelId, pollId),
      db.prepare(
        `DELETE FROM chat_vote_result_delivery_reconciliation
          WHERE channel_id = ? AND poll_id = ?`,
      ).bind(channelId, pollId),
    ]);
    return (result?.meta.changes ?? 0) > 0;
  },
});
