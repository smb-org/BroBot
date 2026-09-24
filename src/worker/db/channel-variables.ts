import {
  CHANNEL_VARIABLE_MAXIMUM_VALUE,
  CHANNEL_VARIABLE_MINIMUM_VALUE,
} from "../../contracts/values";

export interface ChannelVariableRecord {
  channelId: string;
  name: string;
  value: number;
  description: string;
  resetOnStreamStart: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChannelVariableRow {
  channel_id: string;
  name: string;
  value: number;
  description: string;
  reset_on_stream_start: number;
  created_at: string;
  updated_at: string;
}

const mapVariable = (row: ChannelVariableRow): ChannelVariableRecord => ({
  channelId: row.channel_id,
  name: row.name,
  value: row.value,
  description: row.description,
  resetOnStreamStart: row.reset_on_stream_start === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listChannelVariables = async (
  db: D1Database,
  channelId: string,
): Promise<ChannelVariableRecord[]> => {
  const result = await db.prepare(
    `SELECT channel_id, name, value, description, reset_on_stream_start, created_at, updated_at
       FROM channel_variables WHERE channel_id = ? ORDER BY name`,
  ).bind(channelId).all<ChannelVariableRow>();
  return result.results.map(mapVariable);
};

export const findChannelVariable = async (
  db: D1Database,
  channelId: string,
  name: string,
): Promise<ChannelVariableRecord | null> => {
  const row = await db.prepare(
    `SELECT channel_id, name, value, description, reset_on_stream_start, created_at, updated_at
       FROM channel_variables WHERE channel_id = ? AND name = ?`,
  ).bind(channelId, name).first<ChannelVariableRow>();
  return row === null ? null : mapVariable(row);
};

/** Reads all requested names in one channel-bound query. */
export const readChannelVariables = async (
  db: D1Database,
  channelId: string,
  names: readonly string[],
): Promise<Readonly<Record<string, number>>> => {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) return {};
  const placeholders = uniqueNames.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT name, value FROM channel_variables
      WHERE channel_id = ? AND name IN (${placeholders})`,
  ).bind(channelId, ...uniqueNames).all<{ name: string; value: number }>();
  return Object.fromEntries(rows.results.map(({ name, value }) => [name, value]));
};

export interface ChannelVariableChange {
  name: string;
  operation: "add" | "subtract" | "set" | "set_argument";
  /** The command's literal amount, or the already validated argument amount. */
  amount: number | null;
}

/** Prepared for a command claim batch. The host binds the tenant key from the verified event. */
export const prepareChannelVariableChange = (
  db: D1Database,
  channelId: string,
  change: ChannelVariableChange,
  now: string,
  claim: { commandName: string; revision: number; userId: string | null },
): D1PreparedStatement => {
  const amount = change.amount ?? 0;
  const minimumValue = String(CHANNEL_VARIABLE_MINIMUM_VALUE);
  const maximumValue = String(CHANNEL_VARIABLE_MAXIMUM_VALUE);
  return db.prepare(
    `UPDATE channel_variables
        SET value = CASE ?
              WHEN 'set' THEN ?
              WHEN 'set_argument' THEN ?
              WHEN 'add' THEN max(${minimumValue}, min(${maximumValue}, value + ?))
              ELSE max(${minimumValue}, min(${maximumValue}, value - ?))
            END,
            updated_at = ?
      WHERE channel_id = ? AND name = ?
        AND EXISTS (
          SELECT 1 FROM text_commands AS command
           WHERE command.channel_id = ? AND command.command_name = ? AND command.enabled = 1
             AND (command.last_used_at IS NULL OR julianday(command.last_used_at) <= julianday(?) - command.cooldown_seconds / 86400.0)
             AND command.revision = ?
             AND (? IS NULL OR command.user_cooldown_seconds = 0 OR NOT EXISTS (
               SELECT 1 FROM text_command_user_cooldowns AS user_cooldown
                WHERE user_cooldown.channel_id = command.channel_id
                  AND user_cooldown.command_name = command.command_name
                  AND user_cooldown.user_id = ?
                  AND julianday(user_cooldown.last_used_at) > julianday(?) - command.user_cooldown_seconds / 86400.0
             ))
        )
      RETURNING name, value`,
  ).bind(change.operation, amount, amount, amount, amount, now, channelId, change.name,
    channelId, claim.commandName, now, claim.revision, claim.userId, claim.userId, now);
};

export const prepareResetChannelVariablesForStream = (
  db: D1Database,
  channelId: string,
  startedAt: string,
  now: string,
): Promise<boolean> => db.batch([
  db.prepare(
    `INSERT INTO channel_variable_stream_resets (channel_id, started_at)
     VALUES (?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET started_at = excluded.started_at
       WHERE julianday(excluded.started_at) > julianday(channel_variable_stream_resets.started_at)`,
  ).bind(channelId, startedAt),
  db.prepare(
    `UPDATE channel_variables SET value = 0, updated_at = ?
      WHERE channel_id = ? AND reset_on_stream_start = 1 AND changes() > 0`,
  ).bind(now, channelId),
]).then((results) => (results[0]?.meta.changes ?? 0) > 0);
