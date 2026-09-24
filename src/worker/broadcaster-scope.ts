interface IdentityScopeRow {
  scopes_json: string;
  status: string;
}

export const broadcasterScopesForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<string[]> => {
  const row = await db.prepare(
    `SELECT scopes_json, status
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(channelId).first<IdentityScopeRow>();
  if (row?.status !== "connected") return [];
  try {
    const parsed: unknown = JSON.parse(row.scopes_json);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
  } catch {
    return [];
  }
};

export const broadcasterHasScope = async (
  db: D1Database,
  channelId: string,
  scope: string,
): Promise<boolean> => (await broadcasterScopesForChannel(db, channelId)).includes(scope);
