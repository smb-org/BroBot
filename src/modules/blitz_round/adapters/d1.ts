import {
  BLITZ_QUESTION_MAXIMUM_COUNT,
  BLITZ_QUESTION_PAGE_SIZE,
  type BlitzQuestion,
  type BlitzQuestionInput,
} from "../contracts";
import { validateBlitzQuestion } from "../domain/questions";
import type { BlitzQuestionRepository } from "../repository";

interface BlitzQuestionRow {
  question_id: string;
  revision: number;
  kind: "scramble" | "quiz";
  prompt: string;
  answers_json: string;
  enabled: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapRow = (row: BlitzQuestionRow): BlitzQuestion => {
  let answers: unknown;
  try { answers = JSON.parse(row.answers_json) as unknown; } catch { answers = []; }
  return {
    id: row.question_id,
    revision: row.revision,
    kind: row.kind,
    prompt: row.prompt,
    answers: Array.isArray(answers) ? answers.filter((answer): answer is string => typeof answer === "string") : [],
    enabled: row.enabled === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const blitzQuestionColumns = `question_id, revision, kind, prompt, answers_json, enabled, last_used_at, created_at, updated_at`;

const validate = (input: BlitzQuestionInput): BlitzQuestionInput => {
  const checked = validateBlitzQuestion(input);
  if (!checked.ok) throw new Error(checked.code);
  return checked.value;
};

export const createBlitzQuestionRepository = (db: D1Database): BlitzQuestionRepository => ({
  async list(channelId, page, search = "") {
    const boundedPage = Math.max(1, Math.trunc(page));
    const term = search.trim().slice(0, 120);
    const blitzSearchFilter = term.length === 0 ? "" : " AND (prompt LIKE ? ESCAPE '\\' OR answers_json LIKE ? ESCAPE '\\')";
    const pattern = `%${term.replace(/[\\%_]/gu, "\\$&")}%`;
    const count = await db.prepare(`SELECT COUNT(*) AS total FROM blitz_questions WHERE channel_id = ?${blitzSearchFilter}`)
      .bind(channelId, ...(term.length === 0 ? [] : [pattern, pattern])).first<{ total: number }>();
    const rows = await db.prepare(
      `SELECT ${blitzQuestionColumns} FROM blitz_questions WHERE channel_id = ?${blitzSearchFilter}
        ORDER BY updated_at DESC, question_id LIMIT ? OFFSET ?`,
    ).bind(channelId, ...(term.length === 0 ? [] : [pattern, pattern]), BLITZ_QUESTION_PAGE_SIZE,
      (boundedPage - 1) * BLITZ_QUESTION_PAGE_SIZE).all<BlitzQuestionRow>();
    return { questions: rows.results.map(mapRow), total: count?.total ?? 0, page: boundedPage };
  },
  async get(channelId, questionId) {
    const row = await db.prepare(
      `SELECT ${blitzQuestionColumns} FROM blitz_questions WHERE channel_id = ? AND question_id = ?`,
    ).bind(channelId, questionId).first<BlitzQuestionRow>();
    return row === null ? null : mapRow(row);
  },
  async create(channelId, value, now) {
    const input = validate(value);
    const id = crypto.randomUUID();
    const result = await db.prepare(
      `INSERT INTO blitz_questions (channel_id, question_id, kind, prompt, answers_json, enabled, last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?
        WHERE (SELECT COUNT(*) FROM blitz_questions WHERE channel_id = ?) < ?`,
    ).bind(channelId, id, input.kind, input.prompt, JSON.stringify(input.answers), input.enabled ? 1 : 0,
      now, now, channelId, BLITZ_QUESTION_MAXIMUM_COUNT).run();
    if (result.meta.changes === 0) throw new Error("question_limit_reached");
    const created = await this.get(channelId, id);
    if (created === null) throw new Error("question_not_found");
    return created;
  },
  async update(channelId, questionId, revision, value, now) {
    const input = validate(value);
    const result = await db.prepare(
      `UPDATE blitz_questions SET kind = ?, prompt = ?, answers_json = ?, enabled = ?, revision = revision + 1, updated_at = ?
        WHERE channel_id = ? AND question_id = ? AND revision = ?`,
    ).bind(input.kind, input.prompt, JSON.stringify(input.answers), input.enabled ? 1 : 0, now, channelId, questionId, revision).run();
    return result.meta.changes === 0 ? null : this.get(channelId, questionId);
  },
  async delete(channelId, questionId, revision) {
    const result = await db.prepare("DELETE FROM blitz_questions WHERE channel_id = ? AND question_id = ? AND revision = ?")
      .bind(channelId, questionId, revision).run();
    return result.meta.changes > 0;
  },
  async enabledCount(channelId) {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM blitz_questions WHERE channel_id = ? AND enabled = 1")
      .bind(channelId).first<{ count: number }>();
    return row?.count ?? 0;
  },
  async pick(channelId) {
    const row = await db.prepare(
      `SELECT ${blitzQuestionColumns} FROM blitz_questions WHERE channel_id = ? AND enabled = 1
        ORDER BY (last_used_at IS NOT NULL), last_used_at, random() LIMIT 1`,
    ).bind(channelId).first<BlitzQuestionRow>();
    return row === null ? null : mapRow(row);
  },
  async markUsed(channelId, questionId, now) {
    await db.prepare("UPDATE blitz_questions SET last_used_at = ? WHERE channel_id = ? AND question_id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .bind(now, channelId, questionId, now).run();
  },
  async seed(channelId, words, now) {
    const result = await db.prepare(
      `INSERT INTO blitz_questions
        (channel_id, question_id, kind, prompt, answers_json, enabled, last_used_at, created_at, updated_at)
       SELECT ?, 'seed-' || lower(value), 'scramble', value, json_array(value), 1, NULL, ?, ?
         FROM json_each(?)
        WHERE NOT EXISTS (SELECT 1 FROM blitz_questions WHERE channel_id = ?) RETURNING question_id`,
    ).bind(channelId, now, now, JSON.stringify(words), channelId).all<{ question_id: string }>();
    return result.results.length;
  },
});
