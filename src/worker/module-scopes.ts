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
  module_id: string | null;
}

interface IdentityScopeRow {
  scopes_json: string;
  status: string;
}

interface IdentityTokenScopeRow {
  token_scopes_json: string;
  status: string;
}

const unique = (scopes: readonly string[]): string[] => [...new Set(scopes)];

const alternativeGroups = (module: BotModule | undefined): readonly (readonly string[])[] =>
  module?.broadcasterScopeAlternatives ?? [];

/** Resolves module all-of scopes plus one least-privileged scope from each any-of group. */
export const resolveBroadcasterScopes = (
  modules: readonly BotModule[],
  grantedScopes: readonly string[] = [],
): string[] => {
  const granted = new Set(grantedScopes);
  const required = new Set(modules.flatMap((module) => module.broadcasterScopes ?? []));
  const resolved = new Set(required);
  const orderedGroups = modules.flatMap((module) => alternativeGroups(module));
  for (const group of orderedGroups) {
    const alternatives = [...new Set(group)].sort((left, right) =>
      left.length - right.length || left.localeCompare(right));
    const alreadyAvailable = alternatives.find((scope) => granted.has(scope) || required.has(scope));
    const selected = alreadyAvailable ?? alternatives[0];
    if (selected !== undefined) resolved.add(selected);
  }
  return [...resolved];
};

/** Determines the derived full scope set for flagged channels. */
export const listAllBroadcasterScopes = (): string[] => unique([
  ...LOGIN_SCOPES,
  ...resolveBroadcasterScopes(MODULES),
  ...VOLLUMFANG_BROADCASTER_SCOPES,
]);

const declaredScopes = (module: BotModule | undefined): string[] =>
  unique(module?.broadcasterScopes ?? []);

/** Scopes a module knows about for optional operator actions. */
export const moduleOptionalBroadcasterScopes = (module: BotModule): string[] =>
  module.id === "ads" ? [...ADS_OPTIONAL_BROADCASTER_SCOPES]
    : module.id === "temp_vips" ? ["channel:manage:vips"] : [];

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

const broadcasterIdentityTokenScopes = async (
  db: D1Database,
  channelId: string,
): Promise<string[]> => {
  const row = await db.prepare(
    `SELECT token_scopes_json, status
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(channelId).first<IdentityTokenScopeRow>();
  if (row === null || row.status !== "connected") return [];
  return parseScopes(row.token_scopes_json);
};

export const moduleBroadcasterScopeState = async (
  db: D1Database,
  channelId: string,
  module: BotModule,
): Promise<ModuleBroadcasterScopeState> => {
  const grantedScopes = await broadcasterIdentityScopes(db, channelId);
  const required = resolveBroadcasterScopes([module], grantedScopes);
  if (required.length === 0) return { required, missing: [] };
  const granted = new Set(grantedScopes);
  return { required, missing: required.filter((scope) => !granted.has(scope)) };
};

export const moduleOptionalBroadcasterScopeState = async (
  db: D1Database,
  channelId: string,
  module: BotModule,
): Promise<{ optional: string[]; missingOptional: string[] }> => {
  const optional = moduleOptionalBroadcasterScopes(module);
  if (optional.length === 0) return { optional, missingOptional: [] };
  const granted = new Set(await broadcasterIdentityScopes(db, channelId));
  return { optional, missingOptional: optional.filter((scope) => !granted.has(scope)) };
};

const moduleMissingBroadcasterScopes = (
  module: BotModule,
  grantedScopes: readonly string[],
): string[] => {
  const granted = new Set(grantedScopes);
  return unique([
    ...declaredScopes(module).filter((scope) => !granted.has(scope)),
    ...alternativeGroups(module).flatMap((group) => group.some((scope) => granted.has(scope)) ? [] : group),
  ]);
};

export const moduleHasRequiredBroadcasterScopes = (
  module: BotModule,
  grantedScopes: readonly string[],
): boolean => moduleMissingBroadcasterScopes(module, grantedScopes).length === 0;

const enabledModulesForUser = async (
  db: D1Database,
  userId: string,
  registry: readonly BotModule[] = MODULES,
): Promise<BotModule[]> => {
  const rows = await db.prepare(
    `SELECT channel_modules.module_id
       FROM channel_members
       LEFT JOIN channel_modules
         ON channel_modules.channel_id = channel_members.channel_id
        AND channel_modules.enabled = 1
      WHERE channel_members.user_id = ?
        AND channel_members.channel_id = ?
        AND channel_members.role = ${sqlRole("broadcaster")}
      ORDER BY channel_modules.module_id`,
  ).bind(userId, userId).all<ModuleChannelRow>();
  const enabledIds = new Set(rows.results.flatMap(({ module_id }) => module_id === null ? [] : [module_id]));
  for (const module of registry) if (module.mandatory === true) enabledIds.add(module.id);
  return registry.filter((module) => enabledIds.has(module.id));
};

/** Collects enabled-module scopes, retaining optional scopes currently in use. */
export const listRequiredBroadcasterScopesForUser = async (
  db: D1Database,
  userId: string,
  registry: readonly BotModule[] = MODULES,
): Promise<string[]> => {
  const modules = await enabledModulesForUser(db, userId, registry);
  const grantedScopes = await broadcasterIdentityScopes(db, userId);
  const tokenScopes = new Set(await broadcasterIdentityTokenScopes(db, userId));
  return unique([
    ...resolveBroadcasterScopes(modules, grantedScopes),
    ...modules.flatMap((module) => moduleOptionalBroadcasterScopes(module).filter((scope) => tokenScopes.has(scope))),
  ]);
};

/** Adds the requested registry module's scopes to the already-required ones. */
export const listRequiredBroadcasterScopesForUserAndModule = async (
  db: D1Database,
  userId: string,
  module: BotModule,
): Promise<string[]> => {
  const modules = await enabledModulesForUser(db, userId);
  const grantedScopes = await broadcasterIdentityScopes(db, userId);
  const tokenScopes = new Set(await broadcasterIdentityTokenScopes(db, userId));
  const activeScopes = unique([
    ...resolveBroadcasterScopes(modules, grantedScopes),
    ...modules.flatMap((enabledModule) =>
      moduleOptionalBroadcasterScopes(enabledModule).filter((scope) => tokenScopes.has(scope))),
  ]);
  return unique([
    ...activeScopes,
    ...resolveBroadcasterScopes([...modules, module], [...grantedScopes, ...activeScopes]),
    ...moduleOptionalBroadcasterScopes(module),
  ]);
};

export const moduleScopeRequirement = (module: BotModule): string[] => resolveBroadcasterScopes([module]);

const lostModuleScopes = (
  module: BotModule,
  previousScopes: ReadonlySet<string>,
  newScopes: ReadonlySet<string>,
): string[] => {
  const lostRequired = declaredScopes(module).filter((scope) => previousScopes.has(scope) && !newScopes.has(scope));
  const lostAlternatives = alternativeGroups(module).flatMap((group) => {
    if (!group.some((scope) => previousScopes.has(scope)) || group.some((scope) => newScopes.has(scope))) return [];
    return group.filter((scope) => previousScopes.has(scope));
  });
  const lostOptional = moduleOptionalBroadcasterScopes(module)
    .filter((scope) => previousScopes.has(scope) && !newScopes.has(scope));
  return [...lostRequired, ...lostAlternatives, ...lostOptional];
};

/** Finds scopes a connected token currently holds for an enabled module that a replacement would remove. */
const missingEnabledModuleBroadcasterScopes = async (
  db: D1Database,
  userId: string,
  newScopes: readonly string[],
  registry: readonly BotModule[] = MODULES,
): Promise<string[]> => {
  const modules = await enabledModulesForUser(db, userId, registry);
  const previousScopes = new Set(await broadcasterIdentityTokenScopes(db, userId));
  const nextScopes = new Set(newScopes);
  return unique(modules.flatMap((module) => lostModuleScopes(module, previousScopes, nextScopes)));
};

/** Prevents replacing a connected broadcaster token when it would drop a scope used by an enabled module. */
export const broadcasterTokenPreservesEnabledModuleScopes = async (
  db: D1Database,
  userId: string,
  newScopes: readonly string[],
  registry: readonly BotModule[] = MODULES,
): Promise<boolean> => (await missingEnabledModuleBroadcasterScopes(db, userId, newScopes, registry)).length === 0;
