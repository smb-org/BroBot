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
            updated_at = CASE WHEN value <> CASE ?
              WHEN 'set' THEN ?
              WHEN 'set_argument' THEN ?
              WHEN 'add' THEN max(${minimumValue}, min(${maximumValue}, value + ?))
              ELSE max(${minimumValue}, min(${maximumValue}, value - ?))
            END THEN ? ELSE updated_at END
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
  ).bind(change.operation, amount, amount, amount, amount,
    change.operation, amount, amount, amount, amount, now, channelId, change.name,
    channelId, claim.commandName, now, claim.revision, claim.userId, claim.userId, now);
};

export const prepareResetChannelVariablesForStream = (
  db: D1Database,
  channelId: string,
  startedAt: string,
  now: string,
  streamId: string | null = null,
): Promise<string[]> => db.batch([
  db.prepare(
    `INSERT INTO channel_variable_stream_resets (channel_id, started_at, stream_id, started_at_epoch_ms)
     SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM channel_stream_state
         WHERE channel_id = ? AND state = 'online'
           AND ((? IS NOT NULL AND stream_id IS NOT NULL AND stream_id = ?)
             OR ((? IS NULL OR stream_id IS NULL)
              AND COALESCE(started_at_epoch_ms,
                   CAST(round((julianday(started_at) - 2440587.5) * 86400000.0) AS INTEGER)) = ?))
      )
     ON CONFLICT (channel_id) DO UPDATE
       SET started_at = excluded.started_at,
           stream_id = COALESCE(excluded.stream_id, channel_variable_stream_resets.stream_id),
           started_at_epoch_ms = excluded.started_at_epoch_ms
       WHERE (
         (excluded.stream_id IS NOT NULL AND channel_variable_stream_resets.stream_id IS NOT NULL
          AND excluded.stream_id <> channel_variable_stream_resets.stream_id
          AND excluded.started_at_epoch_ms >= channel_variable_stream_resets.started_at_epoch_ms)
         OR ((excluded.stream_id IS NULL OR channel_variable_stream_resets.stream_id IS NULL)
          AND excluded.started_at_epoch_ms > channel_variable_stream_resets.started_at_epoch_ms)
       )`,
  ).bind(channelId, startedAt, streamId, Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : null,
    channelId, streamId, streamId, streamId,
    Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : null),
  db.prepare(
    `UPDATE channel_variables SET value = 0, updated_at = ?
      WHERE channel_id = ? AND reset_on_stream_start = 1 AND value <> 0 AND changes() > 0
      RETURNING name`,
  ).bind(now, channelId),
  db.prepare(
    `UPDATE channel_variable_stream_resets
        SET stream_id = ?
      WHERE channel_id = ? AND stream_id IS NULL AND ? IS NOT NULL
        AND started_at_epoch_ms = ?
        AND EXISTS (
          SELECT 1 FROM channel_stream_state
           WHERE channel_id = ? AND state = 'online'
             AND ((? IS NOT NULL AND stream_id IS NOT NULL AND stream_id = ?)
               OR ((? IS NULL OR stream_id IS NULL)
                AND COALESCE(started_at_epoch_ms,
                     CAST(round((julianday(started_at) - 2440587.5) * 86400000.0) AS INTEGER)) = ?))
        )`,
  ).bind(streamId, channelId, streamId,
    Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : null,
    channelId, streamId, streamId, streamId,
    Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : null),
]).then((results) => (results[1]?.results ?? []).flatMap((row: unknown) => {
  if (typeof row !== "object" || row === null) return [];
  const name = Reflect.get(row, "name") as unknown;
  return typeof name === "string" ? [name] : [];
}));
