export type ChatVoteResultTextReference = {
  source_kind: "template" | "running_vote" | "replay_vote";
  source_id: string;
  item_name: string | null;
  result_text: string;
};

const currentVoteResultTextWhere = (alias: string): string => `(
  ${alias}.status = 'open'
  OR (
    ${alias}.status = 'closed'
    AND NOT EXISTS (
      SELECT 1
        FROM chat_votes AS active
       WHERE active.channel_id = ${alias}.channel_id AND active.status = 'open'
    )
    AND ${alias}.poll_id = (
      SELECT latest.poll_id
        FROM chat_votes AS latest
       WHERE latest.channel_id = ${alias}.channel_id AND latest.status = 'closed'
       ORDER BY latest.opened_at DESC
       LIMIT 1
    )
  )
)`;

export const CHAT_VOTE_RESULT_TEXT_REFERENCE_CURRENT_VOTE_WHERE_SQL = currentVoteResultTextWhere("chat_votes");
export const CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL = " AND instr(result_reference.result_text, ?) > 0";
export const CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Saved results, the active vote, and the closed vote that `!vote again` can replay. */
export const CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL = `
  SELECT template.channel_id, 'template' AS source_kind, template.id AS source_id,
         template.title AS item_name, template.result_text
    FROM chat_vote_templates AS template
   WHERE template.result_text IS NOT NULL
  UNION ALL
  SELECT vote.channel_id,
         CASE WHEN vote.status = 'open' THEN 'running_vote' ELSE 'replay_vote' END AS source_kind,
         vote.poll_id AS source_id,
         vote.title AS item_name, vote.result_text
    FROM chat_votes AS vote
   WHERE vote.result_text IS NOT NULL AND ${currentVoteResultTextWhere("vote")}
`;

export const CHAT_VOTE_RESULT_TEXT_REFERENCE_EXISTS_SQL = `EXISTS (
  SELECT 1
    FROM (${CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL}) AS result_reference
   WHERE result_reference.channel_id = ? AND instr(result_reference.result_text, ?) > 0
)`;

export const findChatVoteResultTextReferences = async (
  db: D1Database,
  channelId: string,
  token?: string,
): Promise<readonly ChatVoteResultTextReference[]> => {
  const tokenPredicate = token === undefined ? "" : CHAT_VOTE_RESULT_TEXT_REFERENCE_TOKEN_PREDICATE_SQL;
  const values = token === undefined ? [channelId] : [channelId, token];
  const rows = await db.prepare(
    `SELECT result_reference.source_kind, result_reference.source_id, result_reference.item_name, result_reference.result_text
       FROM (${CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL}) AS result_reference
      WHERE result_reference.channel_id = ?${tokenPredicate}
      ORDER BY CASE result_reference.source_kind WHEN 'template' THEN 0 WHEN 'running_vote' THEN 1 ELSE 2 END,
               result_reference.item_name, result_reference.source_id`,
  ).bind(...values).all<ChatVoteResultTextReference>();
  return rows.results;
};

/** Creates the guarded updates used by every result-text rename path. */
export const prepareChatVoteResultTextReferenceRewrite = (
  db: D1Database,
  options: {
    channelId: string;
    fromToken: string;
    toToken: string;
    updatedAt?: string;
    conditionSql?: string;
    conditionValues?: readonly unknown[];
  },
): readonly D1PreparedStatement[] => {
  const conditionSql = options.conditionSql ?? "1 = 1";
  const conditionValues = options.conditionValues ?? [];
  const updatedAtSql = options.updatedAt === undefined ? CHAT_VOTE_RESULT_TEXT_REFERENCE_DEFAULT_UPDATED_AT_SQL : "?";
  const templateUpdate = db.prepare(
    `UPDATE chat_vote_templates
        SET result_text = replace(result_text, ?, ?), revision = revision + 1, updated_at = ${updatedAtSql}
      WHERE channel_id = ? AND result_text IS NOT NULL AND instr(result_text, ?) > 0 AND ${conditionSql}`,
  ).bind(options.fromToken, options.toToken, ...(options.updatedAt === undefined ? [] : [options.updatedAt]), options.channelId, options.fromToken, ...conditionValues);
  const voteUpdate = db.prepare(
    `UPDATE chat_votes
        SET result_text = replace(result_text, ?, ?)
      WHERE channel_id = ? AND result_text IS NOT NULL AND instr(result_text, ?) > 0
        AND ${CHAT_VOTE_RESULT_TEXT_REFERENCE_CURRENT_VOTE_WHERE_SQL} AND ${conditionSql}`,
  ).bind(options.fromToken, options.toToken, options.channelId, options.fromToken, ...conditionValues);
  return [templateUpdate, voteUpdate];
};
