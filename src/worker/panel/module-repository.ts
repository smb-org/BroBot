import type { PanelActiveModule, PanelModuleState } from "../../panel-contract";
import { MODULES } from "../../modules/registry";

/** Builds sidebar/module-page state with one identity-scope read per channel. */
export interface PanelModuleBatch {
  states: Map<string, PanelModuleState[]>;
  active: Map<string, PanelActiveModule[]>;
}

export const getPanelModuleDataForChannels = async (
  db: D1Database,
  channelIds: readonly string[],
): Promise<PanelModuleBatch> => {
  const states = new Map(channelIds.map((channelId) => [channelId, [] as PanelModuleState[]]));
  const active = new Map(channelIds.map((channelId) => [channelId, [] as PanelActiveModule[]]));
  if (channelIds.length === 0) return { states, active };
  const maxChannelsPerRead = 90;
  for (let offset = 0; offset < channelIds.length; offset += maxChannelsPerRead) {
    const ids = channelIds.slice(offset, offset + maxChannelsPerRead);
    const placeholders = ids.map(() => "?").join(", ");
    const [stored, identityRows] = await Promise.all([
      db.prepare(
        `SELECT channel_id, module_id, enabled, settings
           FROM channel_modules
          WHERE channel_id IN (${placeholders})`,
      ).bind(...ids).all<{ channel_id: string; module_id: string; enabled: number; settings: string }>(),
      db.prepare(
        `SELECT user_id, scopes_json, status
           FROM twitch_login_identity
          WHERE user_id IN (${placeholders})`,
      ).bind(...ids).all<{ user_id: string; scopes_json: string; status: string }>(),
    ]);
    const storedByChannel = new Map<string, Map<string, { enabled: number; settings: string }>>();
    const activeByChannel = new Map<string, PanelActiveModule[]>();
    for (const row of stored.results) {
      const channelModules = storedByChannel.get(row.channel_id) ?? new Map<string, { enabled: number; settings: string }>();
      channelModules.set(row.module_id, row);
      storedByChannel.set(row.channel_id, channelModules);
      if (row.enabled === 1) {
        const enabledModules = activeByChannel.get(row.channel_id) ?? [];
        enabledModules.push({ moduleId: row.module_id, settings: row.settings });
        activeByChannel.set(row.channel_id, enabledModules);
      }
    }
    const scopesByChannel = new Map(identityRows.results.map((row) => {
      let scopes: string[] = [];
      if (row.status === "connected") {
        try {
          const parsed: unknown = JSON.parse(row.scopes_json);
          if (Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string")) scopes = parsed;
        } catch {
          scopes = [];
        }
      }
      return [row.user_id, new Set(scopes)] as const;
    }));
    for (const channelId of ids) {
      const granted = scopesByChannel.get(channelId) ?? new Set<string>();
      const rows = storedByChannel.get(channelId);
      states.set(channelId, MODULES.map((module) => {
        const existing = rows?.get(module.id);
        const required = [...new Set(module.broadcasterScopes ?? [])];
        return {
          id: module.id,
          enabled: module.mandatory === true || existing?.enabled === 1,
          settings: existing?.settings ?? JSON.stringify(module.defaultSettings),
          mandatory: module.mandatory === true,
          ...(required.length === 0 ? {} : {
            requiredBroadcasterScopes: required,
            missingBroadcasterScopes: required.filter((scope) => !granted.has(scope)),
          }),
        };
      }));
      active.set(channelId, activeByChannel.get(channelId) ?? []);
    }
  }
  return { states, active };
};

export const getPanelModuleStatesForChannels = async (
  db: D1Database,
  channelIds: readonly string[],
): Promise<Map<string, PanelModuleState[]>> =>
  (await getPanelModuleDataForChannels(db, channelIds)).states;

export const getPanelModuleStates = async (db: D1Database, channelId: string): Promise<PanelModuleState[]> =>
  (await getPanelModuleStatesForChannels(db, [channelId])).get(channelId) ?? [];
