import type { BotModule } from "../contract";

export interface ModuleCommandCollisionOptions {
  excludeModuleId?: string;
  excludeTextCommandName?: string;
  includeCustomCommands?: boolean;
}

export interface CommandCollisionWriteGuard {
  sql: string;
  values: readonly unknown[];
}

const normalizedTokens = (tokens: readonly string[]): string[] =>
  tokens.map((token) => token.trim().toLocaleLowerCase("en-US")).filter((token) => token.length > 0);

export const combineCommandCollisionWriteGuards = (
  ...guards: readonly CommandCollisionWriteGuard[]
): CommandCollisionWriteGuard => ({
  sql: guards.map((guard) => guard.sql).filter((sql) => sql.length > 0).join(" "),
  values: guards.flatMap((guard) => guard.values),
});

/** Adds the other active modules' command tokens to the mutation's own SQL predicate. */
export const moduleCommandCollisionWriteGuard = (
  channelId: string,
  candidateTokens: readonly string[],
  modules: readonly BotModule[],
  options: Pick<ModuleCommandCollisionOptions, "excludeModuleId"> = {},
): CommandCollisionWriteGuard => {
  const candidates = normalizedTokens(candidateTokens);
  if (candidates.length === 0) return { sql: "", values: [] };
  const candidateJson = JSON.stringify(candidates);
  const conditions: string[] = [];
  const values: unknown[] = [channelId, options.excludeModuleId ?? ""];
  for (const module of modules) {
    if (module.id === options.excludeModuleId) continue;
    const predicates: string[] = [];
    const predicateValues: unknown[] = [];
    const staticTokens = normalizedTokens((module.chatCommands ?? []).map(({ name }) => name));
    if (staticTokens.length > 0) {
      predicates.push(`EXISTS (
        SELECT 1 FROM json_each(?) AS candidate
         WHERE candidate.value IN (${staticTokens.map(() => "?").join(", ")})
      )`);
      predicateValues.push(candidateJson, ...staticTokens);
    }
    for (const field of module.chatCommandSettingsFields ?? []) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(field)) continue;
      predicates.push(`EXISTS (
        SELECT 1 FROM json_each(?) AS candidate
         WHERE candidate.value = lower(json_extract(
           CASE WHEN json_valid(active.settings) THEN active.settings ELSE '{}' END,
           '$.${field}'
         ))
      )`);
      predicateValues.push(candidateJson);
    }
    if (predicates.length === 0) continue;
    conditions.push(`(active.module_id = ? AND (${predicates.join(" OR ")}))`);
    values.push(module.id, ...predicateValues);
  }
  if (conditions.length === 0) return { sql: "", values: [] };
  return {
    sql: `AND NOT EXISTS (
      SELECT 1 FROM channel_modules AS active
       WHERE active.channel_id = ? AND active.enabled = 1 AND active.module_id <> ?
         AND (${conditions.join(" OR ")})
    )`,
    values,
  };
};

/** Adds enabled custom command names and aliases to the mutation's SQL predicate. */
export const textCommandCollisionWriteGuard = (
  channelId: string,
  candidateTokens: readonly string[],
): CommandCollisionWriteGuard => {
  const candidates = normalizedTokens(candidateTokens);
  if (candidates.length === 0) return { sql: "", values: [] };
  const candidateJson = JSON.stringify(candidates);
  return {
    sql: `AND NOT EXISTS (
      SELECT 1 FROM text_commands AS existing
       WHERE existing.channel_id = ? AND existing.enabled = 1
         AND ('!' || lower(existing.command_name) IN (SELECT value FROM json_each(?))
           OR EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(existing.aliases_json) THEN existing.aliases_json ELSE '[]' END) AS alias
              WHERE '!' || lower(alias.value) IN (SELECT value FROM json_each(?))
           ))
    )`,
    values: [channelId, candidateJson, candidateJson],
  };
};

export const effectiveModuleCommandTokens = (module: BotModule, settings: unknown): string[] => {
  const configured = module.chatCommandNames?.(settings) ?? [];
  return normalizedTokens([...(module.chatCommands ?? []).map((command) => command.name), ...configured]);
};

export const findModuleCommandCollision = async (
  db: D1Database,
  channelId: string,
  candidateTokens: readonly string[],
  modules: readonly BotModule[],
  options: ModuleCommandCollisionOptions = {},
): Promise<string | null> => {
  const candidate = new Set(normalizedTokens(candidateTokens));
  if (candidate.size === 0) return null;
  const active = await db.prepare(
    "SELECT module_id, settings FROM channel_modules WHERE channel_id = ? AND enabled = 1 AND module_id <> ?",
  ).bind(channelId, options.excludeModuleId ?? "").all<{ module_id: string; settings: string }>();
  for (const row of active.results) {
    const other = modules.find((entry) => entry.id === row.module_id);
    if (other === undefined) continue;
    try {
      const parsed = other.settingsSchema.safeParse(JSON.parse(row.settings) as unknown);
      if (!parsed.success) continue;
      const collision = effectiveModuleCommandTokens(other, parsed.data).find((name) => candidate.has(name));
      if (collision !== undefined) return collision;
    } catch { /* Invalid legacy settings do not claim a command token. */ }
  }
  if (options.includeCustomCommands === false) return null;
  const customCommands = await db.prepare(
    "SELECT command_name, aliases_json FROM text_commands WHERE channel_id = ? AND enabled = 1 ORDER BY command_name",
  ).bind(channelId).all<{ command_name: string; aliases_json: string }>();
  for (const row of customCommands.results) {
    if (row.command_name === options.excludeTextCommandName) continue;
    let names = [`!${row.command_name}`];
    try {
      const aliases: unknown = JSON.parse(row.aliases_json);
      if (Array.isArray(aliases)) names = [...names, ...aliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `!${alias}`)];
    } catch { /* Keep the command name if legacy aliases are malformed. */ }
    const collision = normalizedTokens(names).find((name) => candidate.has(name));
    if (collision !== undefined) return collision;
  }
  return null;
};
