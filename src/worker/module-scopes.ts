import { MODULES } from "../modules/registry";
import { ADS_OPTIONAL_BROADCASTER_SCOPES } from "../modules/ads/contracts";
import type { BotModule } from "../modules/contract";
import { LOGIN_SCOPES } from "./auth/oauth";
import { sqlRole } from "./db/guards";

/**
 * The full scope set comes from 0009 section 7 and is maintained there. The
 * list stays complete even while individual scopes aren't yet assigned to
 * any module.
 */
export const VOLLUMFANG_BROADCASTER_SCOPES = [
  "channel:read:ads",
  "channel:manage:ads",
  "channel:edit:commercial",
  "channel:manage:polls",
  "channel:manage:predictions",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "channel:read:goals",
  "channel:manage:broadcast",
  "channel:read:vips",
  "channel:manage:vips",
  "channel:manage:raids",
  "channel:manage:schedule",
] as const;

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

/** Determines the derived full scope set for flagged channels. */
export const listAllBroadcasterScopes = (): string[] => unique([
  ...LOGIN_SCOPES,
  ...MODULES.flatMap((module) => declaredScopes(module)),
  ...VOLLUMFANG_BROADCASTER_SCOPES,
]);

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

/** Determines all extra scopes from enabled modules of the user's own broadcaster channels. */
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
        AND channel_members.channel_id = ?
        AND channel_members.role = ${sqlRole("broadcaster")}
      WHERE channel_modules.enabled = 1
      ORDER BY channel_modules.module_id`,
  ).bind(userId, userId).all<ModuleChannelRow>();
  const modules = new Map(MODULES.map((module) => [module.id, module]));
  return unique(rows.results.flatMap((row) => declaredScopes(modules.get(row.module_id))));
};

/** Adds the requested registry module's scopes to the already-required ones. */
export const listRequiredBroadcasterScopesForUserAndModule = async (
  db: D1Database,
  userId: string,
  module: BotModule,
): Promise<string[]> => unique([
  ...declaredScopes(module),
  ...await listRequiredBroadcasterScopesForUser(db, userId),
]);

export const moduleScopeRequirement = (module: BotModule): string[] => declaredScopes(module);

/** Scopes a module knows about for optional operator actions. */
export const moduleOptionalBroadcasterScopes = (module: BotModule): string[] =>
  module.id === "ads" ? [...ADS_OPTIONAL_BROADCASTER_SCOPES] : [];

export { broadcasterHasScope } from "./broadcaster-scope";
