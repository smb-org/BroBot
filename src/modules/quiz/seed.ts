import type { ModuleMutationAuthorization } from "../contract";
import { quizStarterSetContent } from "./locale";

export const quizStarterSetStatements = (
  db: D1Database,
  channelId: string,
  language: "de" | "en",
  now: string,
  authorization: ModuleMutationAuthorization,
  prepareAudit?: (entry: {
    channelId: string;
    moduleId: string;
    action: "quiz.set.created";
    before: null;
    after: Readonly<Record<string, string | number | boolean | null>>;
  }, changedAt: string) => D1PreparedStatement,
): readonly D1PreparedStatement[] => {
  const setId = crypto.randomUUID();
  const starterSet = quizStarterSetContent(language);
  const { name } = starterSet;
  const questions = starterSet.questions.map((question, position) => ({ position, ...question }));
  const createSet = db.prepare(
    `INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM quiz_sets WHERE channel_id = ?)
        AND (SELECT COUNT(*) FROM quiz_sets WHERE channel_id = ?) < 50
        AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_id = ? AND module_id = 'quiz' AND enabled = 1
        ) ${authorization.sql}`,
  ).bind(channelId, setId, name, now, now, channelId, channelId, channelId, ...authorization.values);
  const statements: D1PreparedStatement[] = [createSet];
  if (prepareAudit !== undefined) {
    statements.push(prepareAudit({
      channelId,
      moduleId: "quiz",
      action: "quiz.set.created",
      before: null,
      after: { setId, name, revision: 1, questionCount: questions.length, seeded: true },
    }, now));
  }
  statements.push(db.prepare(
    `INSERT INTO quiz_questions (set_id, position, text, options_json, correct_index, enabled)
     SELECT ?, CAST(json_extract(value, '$.position') AS INTEGER), json_extract(value, '$.text'),
            json_extract(value, '$.options'), CAST(json_extract(value, '$.correctIndex') AS INTEGER),
            CASE WHEN json_extract(value, '$.enabled') THEN 1 ELSE 0 END
       FROM json_each(?)
      WHERE json_array_length(?) <= 100 AND EXISTS (
        SELECT 1 FROM quiz_sets WHERE set_id = ? AND channel_id = ?
      )`,
  ).bind(setId, JSON.stringify(questions), JSON.stringify(questions), setId, channelId));
  return statements;
};
