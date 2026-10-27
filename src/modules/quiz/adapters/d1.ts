import {
  QUIZ_SET_PAGE_SIZE,
  type QuizQuestion,
  type QuizSet,
  type QuizSetPage,
  type QuizSetSummary,
} from "../contracts";
import type { QuizSetRepository } from "../repository";

interface QuizSetRow {
  set_id: string;
  name: string;
  revision: number;
  question_count?: number;
  created_at: string;
  updated_at: string;
}

interface QuizQuestionRow {
  position: number;
  text: string;
  options_json: string;
  correct_index: number;
  enabled: number;
}

const mapSummary = (row: QuizSetRow): QuizSetSummary => ({
  id: row.set_id,
  name: row.name,
  revision: row.revision,
  questionCount: row.question_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapQuestion = (row: QuizQuestionRow): QuizQuestion => {
  let options: unknown;
  try { options = JSON.parse(row.options_json) as unknown; } catch { options = []; }
  return {
    position: row.position,
    text: row.text,
    options: Array.isArray(options) ? options.filter((option): option is string => typeof option === "string") : [],
    correctIndex: row.correct_index,
    enabled: row.enabled === 1,
  };
};

const normalizeSearch = (value: string): string => value.toLocaleLowerCase("de-DE");

export const createQuizSetRepository = (db: D1Database): QuizSetRepository => ({
  async list(channelId, page, search = "") {
    const boundedPage = Math.max(1, Number.isSafeInteger(page) ? page : 1);
    const term = normalizeSearch(search.trim().slice(0, 120));
    const rows = await db.prepare(
      `SELECT quiz_sets.set_id, quiz_sets.name, quiz_sets.revision, quiz_sets.created_at, quiz_sets.updated_at,
              (SELECT COUNT(*) FROM quiz_questions WHERE quiz_questions.set_id = quiz_sets.set_id) AS question_count
         FROM quiz_sets WHERE quiz_sets.channel_id = ?`,
    ).bind(channelId).all<QuizSetRow>();
    const matches = rows.results
      .filter(({ name }) => term.length === 0 || normalizeSearch(name).includes(term))
      .sort((left, right) => {
        const leftName = normalizeSearch(left.name);
        const rightName = normalizeSearch(right.name);
        return leftName < rightName ? -1 : leftName > rightName ? 1 : left.set_id.localeCompare(right.set_id);
      });
    const start = (boundedPage - 1) * QUIZ_SET_PAGE_SIZE;
    const result: QuizSetPage = {
      sets: matches.slice(start, start + QUIZ_SET_PAGE_SIZE).map(mapSummary),
      total: matches.length,
      page: boundedPage,
    };
    return result;
  },

  async get(channelId, setId) {
    const row = await db.prepare(
      "SELECT set_id, name, revision, created_at, updated_at FROM quiz_sets WHERE channel_id = ? AND set_id = ?",
    ).bind(channelId, setId).first<QuizSetRow>();
    if (row === null) return null;
    const questionRows = await db.prepare(
      "SELECT position, text, options_json, correct_index, enabled FROM quiz_questions WHERE set_id = ? ORDER BY position",
    ).bind(setId).all<QuizQuestionRow>();
    return {
      id: row.set_id,
      name: row.name,
      revision: row.revision,
      questions: questionRows.results.map(mapQuestion),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies QuizSet;
  },
});
