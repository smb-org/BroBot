import type { AuditAction } from "../../../contracts/values";
import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
  TextCommandResponseType,
  TextCommandStreamCondition,
} from "../contracts";
import { truncateTo200Chars, type AuthorizeModuleMutation, type PrepareModuleAudit } from "../contract";
import type {
  TextCommandAliasConflict,
  TextCommandMutationResult,
  TextCommandRepository,
} from "../repository";
import { cooldownRemaining } from "../domain";

const MODULE_ID = "text_commands";

const auditValues = (command: TextCommand) => ({
  name: command.name,
  kind: command.kind,
  enabled: command.enabled,
  minimumTier: command.minimumTier,
  text: truncateTo200Chars(command.text),
  cooldownSeconds: command.cooldownSeconds,
  aliases: [...command.aliases],
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  responseType: command.responseType,
});

const sameMutationValues = (left: TextCommand, right: TextCommand): boolean =>
  left.name === right.name &&
  left.text === right.text &&
  left.kind === right.kind &&
  left.enabled === right.enabled &&
  left.minimumTier === right.minimumTier &&
  left.cooldownSeconds === right.cooldownSeconds &&
  left.aliases.length === right.aliases.length &&
  left.aliases.every((alias, index) => alias === right.aliases[index]) &&
  left.userCooldownSeconds === right.userCooldownSeconds &&
  left.streamCondition === right.streamCondition &&
  left.responseType === right.responseType;

const succeeded = (): TextCommandMutationResult => ({ ok: true });

const failed = (
  reason: Exclude<TextCommandMutationResult, { ok: true }>['reason'],
  conflict?: TextCommandAliasConflict,
): TextCommandMutationResult => ({ ok: false, reason, ...(conflict === undefined ? {} : { conflict }) });

const runMutation = async (
  db: D1Database,
  prepareModuleAudit: PrepareModuleAudit | undefined,
  mutation: D1PreparedStatement,
  audit: Parameters<PrepareModuleAudit>[0],
  changedAt: string,
): Promise<number> => {
  if (prepareModuleAudit === undefined) return (await mutation.run()).meta.changes;
  const results = await db.batch([mutation, prepareModuleAudit(audit, changedAt)]);
  return results[0]?.meta.changes ?? 0;
};

interface TextCommandRow {
  channel_id: string;
  command_name: string;
  response_text: string;
  kind: "text" | "list";
  enabled: number;
  minimum_level: "everyone" | "subscriber" | "vip" | "moderator" | "broadcaster";
  cooldown_seconds: number;
  aliases_json: string;
  user_cooldown_seconds: number;
  stream_condition: TextCommandStreamCondition;
  response_type: TextCommandResponseType;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapTextCommand = (row: TextCommandRow): TextCommand => ({
  channelId: row.channel_id,
  name: row.command_name,
  text: row.response_text,
  kind: row.kind,
  enabled: row.enabled === 1,
  minimumTier: row.minimum_level,
  cooldownSeconds: row.cooldown_seconds,
  aliases: JSON.parse(row.aliases_json) as string[],
  userCooldownSeconds: row.user_cooldown_seconds,
  streamCondition: row.stream_condition,
  responseType: row.response_type,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface UserCooldownRow {
  last_used_at: string;
}

interface AliasConflictRow {
  field: "name" | "aliases";
  trigger: string;
  command: string;
}

const aliasConflict = async (
  db: D1Database,
  channelId: string,
  name: string,
  aliases: readonly string[],
  excludeName: string | null,
): Promise<TextCommandAliasConflict | null> => {
  const row = await db.prepare(
    `WITH proposed(value, field) AS (
       SELECT ?, 'name'
       UNION ALL SELECT value, 'aliases' FROM json_each(?)
     )
     SELECT proposed.field, proposed.value AS trigger, other.command_name AS command
       FROM text_commands AS other
       JOIN proposed
         ON other.command_name = proposed.value
         OR EXISTS (
           SELECT 1 FROM json_each(other.aliases_json) AS existing_alias
            WHERE existing_alias.value = proposed.value
         )
      WHERE other.channel_id = ? AND (? IS NULL OR other.command_name <> ?)
      ORDER BY CASE proposed.field WHEN 'name' THEN 0 ELSE 1 END, other.command_name
      LIMIT 1`,
  ).bind(name, JSON.stringify(aliases), channelId, excludeName, excludeName).first<AliasConflictRow>();
  return row === null ? null : { field: row.field, trigger: row.trigger, command: row.command };
};

export const textCommandSelectColumns = `channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
                                       aliases_json, user_cooldown_seconds, stream_condition, response_type,
                                       last_used_at, created_at, updated_at`;

export const createTextCommandRepository = (
  db: D1Database,
  authorizeMutation: AuthorizeModuleMutation,
  prepareModuleAudit?: PrepareModuleAudit,
): TextCommandRepository => ({
  async list(channelId: string): Promise<TextCommand[]> {
    const result = await db.prepare(
      `SELECT ${textCommandSelectColumns}
         FROM text_commands
        WHERE channel_id = ?
        ORDER BY command_name`,
    ).bind(channelId).all<TextCommandRow>();
    return result.results.map(mapTextCommand);
  },

  async find(channelId: string, name: string): Promise<TextCommand | null> {
    const row = await db.prepare(
      `SELECT ${textCommandSelectColumns}
         FROM text_commands
        WHERE channel_id = ? AND command_name = ?`,
    ).bind(channelId, name).first<TextCommandRow>();
    return row === null ? null : mapTextCommand(row);
  },

  async findByAlias(channelId: string, alias: string): Promise<TextCommand | null> {
    const row = await db.prepare(
      `SELECT ${textCommandSelectColumns}
         FROM text_commands AS command, json_each(command.aliases_json) AS alias
        WHERE command.channel_id = ? AND alias.value = ?
        LIMIT 1`,
    ).bind(channelId, alias).first<TextCommandRow>();
    return row === null ? null : mapTextCommand(row);
  },

  async create(input: NewTextCommand, actor: TextCommandActor): Promise<TextCommandMutationResult> {
    if (await this.find(input.channelId, input.name) !== null) return failed("already_exists");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const minimumTier = input.minimumTier ?? "everyone";
    const aliases = input.aliases ?? [];
    const userCooldownSeconds = input.userCooldownSeconds ?? 0;
    const streamCondition = input.streamCondition ?? "any";
    const responseType = input.responseType ?? "say";
    const aliasesJson = JSON.stringify(aliases);
    const mutation = db.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
         aliases_json, user_cooldown_seconds, stream_condition, response_type,
         last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM text_commands AS other
           WHERE other.channel_id = ? AND other.command_name = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM text_commands AS other
             WHERE other.channel_id = ? AND other.command_name <> ?
               AND (other.command_name = ? OR other.command_name IN (SELECT value FROM json_each(?)))
          )
          AND NOT EXISTS (
            SELECT 1 FROM text_commands AS other, json_each(other.aliases_json) AS existing_alias
             WHERE other.channel_id = ? AND other.command_name <> ?
               AND (existing_alias.value = ? OR existing_alias.value IN (SELECT value FROM json_each(?)))
          )
          ${authorization.sql}`,
    ).bind(
      input.channelId,
      input.name,
      input.text,
      input.kind,
      minimumTier,
      input.cooldownSeconds,
      aliasesJson,
      userCooldownSeconds,
      streamCondition,
      responseType,
      input.now,
      input.now,
      input.channelId,
      input.name,
      input.channelId,
      input.name,
      input.name,
      aliasesJson,
      input.channelId,
      input.name,
      input.name,
      aliasesJson,
      ...authorization.values,
    );
    const after: TextCommand = {
      channelId: input.channelId,
      name: input.name,
      text: input.text,
      kind: input.kind,
      enabled: true,
      minimumTier,
      cooldownSeconds: input.cooldownSeconds,
      aliases,
      userCooldownSeconds,
      streamCondition,
      responseType,
      lastUsedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.created" satisfies AuditAction,
      before: null,
      after: auditValues(after),
    }, input.now);
    if (changes > 0) return succeeded();
    if (await this.find(input.channelId, input.name) !== null) return failed("already_exists");
    const conflict = await aliasConflict(db, input.channelId, input.name, aliases, null);
    return conflict === null ? failed("not_authorized") : failed("alias_conflict", conflict);
  },

  async change(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult> {
    const before = await this.find(input.channelId, input.name);
    if (before === null) return failed("not_found");
    if (input.onlyToggle !== true && input.newName !== input.name &&
        await this.find(input.channelId, input.newName) !== null) {
      return failed("already_exists");
    }
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const minimumTier = input.minimumTier ?? before.minimumTier;
    const mutation = input.onlyToggle === true
      ? db.prepare(
        `UPDATE text_commands
            SET enabled = ?, updated_at = ?
          WHERE channel_id = ? AND command_name = ?
            AND response_text = ? AND kind = ? AND enabled = ?
            AND minimum_level = ? AND cooldown_seconds = ? AND aliases_json = ?
            AND user_cooldown_seconds = ? AND stream_condition = ? AND response_type = ?
            ${authorization.sql}`,
      ).bind(
        input.enabled ? 1 : 0,
        input.now,
        input.channelId,
        input.name,
        before.text,
        before.kind,
        before.enabled ? 1 : 0,
        before.minimumTier,
        before.cooldownSeconds,
        JSON.stringify(before.aliases),
        before.userCooldownSeconds,
        before.streamCondition,
        before.responseType,
        ...authorization.values,
      )
      : db.prepare(
        `UPDATE text_commands
            SET command_name = ?, response_text = ?, kind = ?, enabled = ?, minimum_level = ?, cooldown_seconds = ?,
                aliases_json = ?, user_cooldown_seconds = ?, stream_condition = ?, response_type = ?, updated_at = ?
          WHERE channel_id = ? AND command_name = ?
            AND response_text = ? AND kind = ? AND enabled = ?
            AND minimum_level = ? AND cooldown_seconds = ? AND aliases_json = ?
            AND user_cooldown_seconds = ? AND stream_condition = ? AND response_type = ?
            AND (? = command_name OR NOT EXISTS (
              SELECT 1 FROM text_commands AS other
               WHERE other.channel_id = ? AND other.command_name = ?
            ))
            AND NOT EXISTS (
              SELECT 1 FROM text_commands AS other
               WHERE other.channel_id = ? AND other.command_name <> ?
                 AND (other.command_name = ? OR other.command_name IN (SELECT value FROM json_each(?)))
            )
            AND NOT EXISTS (
              SELECT 1 FROM text_commands AS other, json_each(other.aliases_json) AS existing_alias
               WHERE other.channel_id = ? AND other.command_name <> ?
                 AND (existing_alias.value = ? OR existing_alias.value IN (SELECT value FROM json_each(?)))
            )
            ${authorization.sql}`,
      ).bind(
        input.newName,
        input.text,
        input.kind,
        input.enabled ? 1 : 0,
        minimumTier,
        input.cooldownSeconds,
        JSON.stringify(input.aliases),
        input.userCooldownSeconds,
        input.streamCondition,
        input.responseType,
        input.now,
        input.channelId,
        input.name,
        before.text,
        before.kind,
        before.enabled ? 1 : 0,
        before.minimumTier,
        before.cooldownSeconds,
        JSON.stringify(before.aliases),
        before.userCooldownSeconds,
        before.streamCondition,
        before.responseType,
        input.newName,
        input.channelId,
        input.newName,
        input.channelId,
        input.name,
        input.newName,
        JSON.stringify(input.aliases),
        input.channelId,
        input.name,
        input.newName,
        JSON.stringify(input.aliases),
        ...authorization.values,
      );
    const after: TextCommand = input.onlyToggle === true
      ? { ...before, enabled: input.enabled, updatedAt: input.now }
      : {
        ...before,
        name: input.newName,
        text: input.text,
        kind: input.kind,
        enabled: input.enabled,
        minimumTier,
        cooldownSeconds: input.cooldownSeconds,
        aliases: [...input.aliases],
        userCooldownSeconds: input.userCooldownSeconds,
        streamCondition: input.streamCondition,
        responseType: input.responseType,
        updatedAt: input.now,
      };
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.updated" satisfies AuditAction,
      before: auditValues(before),
      after: auditValues(after),
    }, input.now);
    if (changes > 0) return succeeded();

    const current = await this.find(input.channelId, input.name);
    const nameConflict = input.newName === input.name ? null : await this.find(input.channelId, input.newName);
    if (nameConflict !== null) return failed("already_exists");
    const conflict = await aliasConflict(db, input.channelId, input.newName, input.aliases, input.name);
    if (conflict !== null) return failed("alias_conflict", conflict);
    if (current === null) return failed("not_found");
    return failed(sameMutationValues(current, before) ? "not_authorized" : "conflict");
  },

  async delete(channelId: string, name: string, actor: TextCommandActor, now: string): Promise<TextCommandMutationResult> {
    const before = await this.find(channelId, name);
    if (before === null) return failed("not_found");
    const authorization = authorizeMutation(channelId, actor, now);
    const mutation = db.prepare(
      `DELETE FROM text_commands
        WHERE channel_id = ? AND command_name = ?
          AND response_text = ? AND kind = ? AND enabled = ?
          AND minimum_level = ? AND cooldown_seconds = ? AND aliases_json = ?
          AND user_cooldown_seconds = ? AND stream_condition = ? AND response_type = ?
          ${authorization.sql}`,
    ).bind(
      channelId,
      name,
      before.text,
      before.kind,
      before.enabled ? 1 : 0,
      before.minimumTier,
      before.cooldownSeconds,
      JSON.stringify(before.aliases),
      before.userCooldownSeconds,
      before.streamCondition,
      before.responseType,
      ...authorization.values,
    );
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.removed" satisfies AuditAction,
      before: auditValues(before),
      after: null,
    }, now);
    if (changes > 0) return succeeded();
    const current = await this.find(channelId, name);
    if (current === null) return failed("not_found");
    return failed(sameMutationValues(current, before) ? "not_authorized" : "conflict");
  },

  async claim(
    channelId: string,
    name: string,
    now: string,
    userId?: string | null,
    userCooldownSeconds = 0,
  ): Promise<TextCommandClaim | null> {
    const claim = db.prepare(
      `UPDATE text_commands
          SET last_used_at = ?, updated_at = ?
        WHERE channel_id = ? AND command_name = ?
          AND enabled = 1
          AND (last_used_at IS NULL OR julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)
          AND (? IS NULL OR user_cooldown_seconds = 0 OR NOT EXISTS (
            SELECT 1 FROM text_command_user_cooldowns AS user_cooldown
             WHERE user_cooldown.channel_id = ? AND user_cooldown.command_name = ? AND user_cooldown.user_id = ?
               AND julianday(user_cooldown.last_used_at) > julianday(?) - text_commands.user_cooldown_seconds / 86400.0
          ))`,
    ).bind(now, now, channelId, name, now, userId ?? null, channelId, name, userId ?? null, now);

    let globalChanges: number;
    if (userCooldownSeconds > 0 && userId !== undefined && userId !== null) {
      const updateUserCooldown = db.prepare(
        `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
         SELECT ?, ?, ?, ? WHERE changes() > 0
         ON CONFLICT (channel_id, command_name, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      ).bind(channelId, name, userId, now);
      const results = await db.batch([claim, updateUserCooldown]);
      globalChanges = results[0]?.meta.changes ?? 0;
    } else {
      globalChanges = (await claim.run()).meta.changes;
    }

    const current = await this.find(channelId, name);
    if (current === null) return null;
    if (globalChanges > 0) return { command: current, claimed: true };

    const globalRemaining = cooldownRemaining(current.lastUsedAt, now, current.cooldownSeconds);
    if (globalRemaining > 0 || userId === undefined || userId === null || current.userCooldownSeconds === 0) {
      return { command: current, claimed: false, reason: "cooldown", remainingSeconds: globalRemaining };
    }
    const userCooldown = await db.prepare(
      `SELECT last_used_at
         FROM text_command_user_cooldowns
        WHERE channel_id = ? AND command_name = ? AND user_id = ?`,
    ).bind(channelId, name, userId).first<UserCooldownRow>();
    const userRemaining = cooldownRemaining(userCooldown?.last_used_at ?? null, now, current.userCooldownSeconds);
    return {
      command: current,
      claimed: false,
      reason: userRemaining > 0 ? "user_cooldown" : "cooldown",
      remainingSeconds: userRemaining,
    };
  },
});

/** Creates the built-in list command as a normal row once, when the module is enabled. */
export const initializeListCommand = async (
  db: D1Database,
  channelId: string,
  actor: TextCommandActor,
  now: string,
  authorizeMutation: AuthorizeModuleMutation,
  prepareModuleAudit?: PrepareModuleAudit,
): Promise<readonly D1PreparedStatement[] | undefined> => {
  const authorization = authorizeMutation(channelId, actor, now);
  const mutation = db.prepare(
    `INSERT INTO text_commands
      (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
     SELECT ?, 'befehle', '', 'list', 1, 'everyone', 5, NULL, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM text_commands
         WHERE channel_id = ? AND command_name = 'befehle'
      )
      ${prepareModuleAudit === undefined ? "" : "AND changes() > 0"}
      ${authorization.sql}`,
  ).bind(
    channelId,
    now,
    now,
    channelId,
    ...authorization.values,
  );
  if (prepareModuleAudit === undefined) {
    await mutation.run();
    return;
  }
  return [
    mutation,
    prepareModuleAudit({
      channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.created" satisfies AuditAction,
      before: null,
      after: {
        name: "befehle",
        kind: "list",
        enabled: true,
        minimumTier: "everyone",
        text: "",
        cooldownSeconds: 5,
        aliases: [],
        userCooldownSeconds: 0,
        streamCondition: "any",
        responseType: "say",
      },
    }, now),
  ];
};
