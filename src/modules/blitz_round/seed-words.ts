import type { ModuleMutationAuthorization } from "../contract";

export const BLITZ_STARTER_WORDS = [
  "WOLKEN", "LATERNE", "MONDLICHT", "KIESEL", "FENSTER", "KOMPASS", "WALNUSS", "KAMIN",
  "SCHNECKE", "BLUMEN", "KAROTTE", "BAUMHAUS", "REGENBOGEN", "KORB", "TROMMEL", "BIBER",
  "WASSERFALL", "KASTANIE", "ZITRONE", "SCHLUESSEL", "KIRSCHEN", "PAPIERFLIEGER", "EICHHORN",
  "KLEEBLATT", "WINDRAD", "GIRLANDE", "BUECHER", "PFLASTER", "SCHAUFEL", "KORKEN",
] as const;

export const blitzStarterSeedStatement = (db: D1Database, channelId: string, now: string, authorization: ModuleMutationAuthorization): D1PreparedStatement => db.prepare(
  `INSERT INTO blitz_questions
    (channel_id, question_id, kind, prompt, answers_json, enabled, last_used_at, created_at, updated_at)
   SELECT ?, 'seed-' || lower(value), 'scramble', value, json_array(value), 1, NULL, ?, ?
     FROM json_each(?)
    WHERE NOT EXISTS (SELECT 1 FROM blitz_questions WHERE channel_id = ?) ${authorization.sql}`,
).bind(channelId, now, now, JSON.stringify(BLITZ_STARTER_WORDS), channelId, ...authorization.values);
