import type { BotModule } from "../contract";

export interface ModuleCommandCollisionOptions {
  excludeModuleId?: string;
  excludeTextCommandName?: string;
  includeCustomCommands?: boolean;
}

const normalizedTokens = (tokens: readonly string[]): string[] =>
  tokens.map((token) => token.trim().toLocaleLowerCase("en-US")).filter((token) => token.length > 0);

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
