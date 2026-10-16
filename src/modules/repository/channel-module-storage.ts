/**
 * Prepares a channel-module settings mutation. Every persisted settings change
 * advances both the row revision and the settings revision, including indirect
 * rewrites. SQL expressions and predicates are supplied by trusted callers.
 */
export const prepareChannelModuleSettingsWrite = (
  db: D1Database,
  channelId: string,
  moduleId: string | null,
  settingsExpression: string,
  settingsValues: readonly unknown[] = [],
  whereSql = "",
  whereValues: readonly unknown[] = [],
): D1PreparedStatement => db.prepare(
  `UPDATE channel_modules
      SET settings = ${settingsExpression}, revision = revision + 1, settings_revision = settings_revision + 1
    WHERE channel_id = ? ${moduleId === null ? "" : "AND module_id = ?"} ${whereSql}`,
).bind(...settingsValues, channelId, ...(moduleId === null ? [] : [moduleId]), ...whereValues);
