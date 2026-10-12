import { blockReferencesInText } from "./text-block-references";

export interface TextBlockWriteGuard {
  sql: string;
  values: (string | number)[];
  references: readonly string[];
}

/** Reads the channel graph version captured before consumer validation starts. */
export const readTextBlockGraphRevision = async (db: D1Database, channelId: string): Promise<number> => {
  const row = await db.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
    .bind(channelId).first<{ graph_revision: number }>();
  return row?.graph_revision ?? 1;
};

/** Makes a consumer write fail in SQL if validation raced with a graph edit or deletion. */
export const textBlockWriteGuard = (
  channelId: string,
  expectedGraphRevision: number,
  texts: readonly string[],
): TextBlockWriteGuard => {
  const references = [...new Set(texts.flatMap(blockReferencesInText))];
  if (references.length === 0) return { sql: "", values: [], references };
  return {
    sql: `AND COALESCE((SELECT graph_revision FROM text_library_settings WHERE channel_id = ?), 1) = ?
AND NOT EXISTS (
  SELECT 1 FROM json_each(?) AS reference
   WHERE NOT EXISTS (
     SELECT 1 FROM text_blocks WHERE channel_id = ? AND block_name = reference.value
   )
)`,
    values: [channelId, expectedGraphRevision, JSON.stringify(references), channelId],
    references,
  };
};

export const textBlockGraphRevisionChanged = async (
  db: D1Database,
  channelId: string,
  expectedGraphRevision: number,
): Promise<boolean> => (await readTextBlockGraphRevision(db, channelId)) !== expectedGraphRevision;
