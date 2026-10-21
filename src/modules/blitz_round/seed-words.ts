import type { ModuleMutationAuthorization } from "../contract";
import { blitzQuestionSearchText } from "./adapters/d1";

export const BLITZ_STARTER_WORDS = [
  "WOLKEN", "LATERNE", "MONDLICHT", "KIESEL", "FENSTER", "KOMPASS", "WALNUSS", "KAMIN",
  "SCHNECKE", "BLUMEN", "KAROTTE", "BAUMHAUS", "REGENBOGEN", "KORB", "TROMMEL", "BIBER",
  "WASSERFALL", "KASTANIE", "ZITRONE", "SCHLUESSEL", "KIRSCHEN", "PAPIERFLIEGER", "EICHHORN",
  "KLEEBLATT", "WINDRAD", "GIRLANDE", "BUECHER", "PFLASTER", "SCHAUFEL", "KORKEN",
] as const;

export const blitzStarterSeedStatement = (db: D1Database, channelId: string, now: string, authorization: ModuleMutationAuthorization): D1PreparedStatement => {
  const seedRows = BLITZ_STARTER_WORDS.map((word) => ({ id: crypto.randomUUID(), word, searchText: blitzQuestionSearchText(word, [word]) }));
  return db.prepare(
    `INSERT INTO blitz_questions
      (channel_id, question_id, kind, prompt, answers_json, search_text, enabled, last_used_at, created_at, updated_at)
     SELECT ?, json_extract(value, '$.id'), 'scramble', json_extract(value, '$.word'),
       json_array(json_extract(value, '$.word')), json_extract(value, '$.searchText'), 1, NULL, ?, ?
       FROM json_each(?)
      WHERE NOT EXISTS (SELECT 1 FROM blitz_questions WHERE channel_id = ?) ${authorization.sql}`,
  ).bind(channelId, now, now, JSON.stringify(seedRows), channelId, ...authorization.values);
};
