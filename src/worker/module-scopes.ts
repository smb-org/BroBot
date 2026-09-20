import { MODULES } from "../modules/registry";
import type { BotModule } from "../modules/contract";

export interface ModuleBroadcasterScopeState {
  required: string[];
  missing: string[];
}

interface ModuleChannelRow {
  module_id: string;
}

interface IdentityScopeRow {
  scopes_json: string;
  status: string;
}

const unique = (scopes: readonly string[]): string[] => [...new Set(scopes)];

const declaredScopes = (module: BotModule | undefined): string[] =>
  unique(module?.broadcasterScopes ?? []);

const parseScopes = (serialized: string | null | undefined): string[] => {
  if (serialized === null || serialized === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string")
      ? unique(parsed)
      : [];
  } catch {
    return [];
  }
};

const broadcasterIdentityScopes = async (
  db: D1Database,
  channelId: string,
): Promise<string[]> => {
  const row = await db.prepare(
    `SELECT scopes_json, status
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(channelId).first<IdentityScopeRow>();
  return row?.status === "connected" ? parseScopes(row.scopes_json) : [];
};

export const moduleBroadcasterScopeState = async (
  db: D1Database,
  channelId: string,
  module: BotModule,
): Promise<ModuleBroadcasterScopeState> => {
  const required = declaredScopes(module);
  if (required.length === 0) return { required, missing: [] };
  const granted = new Set(await broadcasterIdentityScopes(db, channelId));
  return { required, missing: required.filter((scope) => !granted.has(scope)) };
};

export const moduleHasRequiredBroadcasterScopes = (
  module: BotModule,
  grantedScopes: readonly string[],
): boolean => {
  const granted = new Set(grantedScopes);
  return declaredScopes(module).every((scope) => granted.has(scope));
};

/** Ermittelt alle Zusatz-Scopes aus aktivierten Modulen eigener Broadcaster-Kanäle. */
export const listRequiredBroadcasterScopesForUser = async (
  db: D1Database,
  userId: string,
): Promise<string[]> => {
  const rows = await db.prepare(
    `SELECT channel_modules.module_id
       FROM channel_modules
       JOIN channel_members
         ON channel_members.channel_id = channel_modules.channel_id
        AND channel_members.user_id = ?
        AND channel_members.role = 'broadcaster'
      WHERE channel_modules.enabled = 1
      ORDER BY channel_modules.module_id`,
  ).bind(userId).all<ModuleChannelRow>();
  const modules = new Map(MODULES.map((module) => [module.id, module]));
  return unique(rows.results.flatMap((row) => declaredScopes(modules.get(row.module_id))));
};

/** Ergänzt die bereits benötigten Scopes um das angeforderte Registry-Modul. */
export const listRequiredBroadcasterScopesForUserAndModule = async (
  db: D1Database,
  userId: string,
  module: BotModule,
): Promise<string[]> => unique([
  ...declaredScopes(module),
  ...await listRequiredBroadcasterScopesForUser(db, userId),
]);

export const moduleScopeRequirement = (module: BotModule): string[] => declaredScopes(module);
