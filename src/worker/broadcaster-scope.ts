interface IdentityScopeRow {
  scopes_json: string;
  status: string;
}

interface IdentityTokenScopeRow {
  token_scopes_json: string;
  status: string;
}

const parseScopes = (serialized: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
  } catch {
    return [];
  }
};

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
  return parseScopes(row.scopes_json);
};

export const broadcasterHasScope = async (
  db: D1Database,
  channelId: string,
  scope: string,
): Promise<boolean> => (await broadcasterScopesForChannel(db, channelId)).includes(scope);

export const broadcasterTokenHasScope = async (
  db: D1Database,
  channelId: string,
  scope: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `SELECT token_scopes_json, status
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(channelId).first<IdentityTokenScopeRow>();
  return row?.status === "connected" && parseScopes(row.token_scopes_json).includes(scope);
};
