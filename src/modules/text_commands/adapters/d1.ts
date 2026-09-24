import type { AuditAction, ChannelVariableOperation } from "../../../contracts/values";
import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
  TextCommandKind,
  TextCommandResponseType,
  TextCommandStreamCondition,
  PrepareTextCommandVariableChange,
} from "../contracts";
import { textFingerprintIfTruncated, truncateTo200Chars, type AuthorizeModuleMutation, type PrepareModuleAudit } from "../contract";
import type {
  TextCommandAliasConflict,
  TextCommandMutationResult,
  TextCommandRepository,
} from "../repository";
import { cooldownRemaining, initialTextCommandRevision } from "../domain";

const MODULE_ID = "text_commands";
const extraTemplateKeys = ["offlineText", "notFollowingText", "unavailableText", "usageText"] as const;

/**
 * Preview plus, only past the truncation cutoff, a `${key}Hash` fingerprint
 * of the full value (#181 review): otherwise an edit that only touches text
 * after character 200 truncates to the same preview on both sides and the
 * audit diff would show no change at all.
 */
const previewField = async (key: string, text: string): Promise<Record<string, string>> => {
  const hash = await textFingerprintIfTruncated(text);
  return hash === undefined ? { [key]: truncateTo200Chars(text) } : { [key]: truncateTo200Chars(text), [`${key}Hash`]: hash };
};

const auditValues = async (command: TextCommand) => ({
  name: command.name,
  kind: command.kind,
  enabled: command.enabled,
  minimumTier: command.minimumTier,
  ...await previewField("text", command.text),
  cooldownSeconds: command.cooldownSeconds,
  aliases: [...command.aliases],
  userCooldownSeconds: command.userCooldownSeconds,
  streamCondition: command.streamCondition,
  responseType: command.responseType,
  ...(command.variableAction === null ? {} : {
    variableName: command.variableAction.name,
    variableOperation: command.variableAction.operation,
    variableAmount: command.variableAction.amount,
  }),
  ...(command.offlineText === undefined ? {} : await previewField("offlineText", command.offlineText)),
  ...(command.notFollowingText === undefined ? {} : await previewField("notFollowingText", command.notFollowingText)),
  ...(command.unavailableText === undefined ? {} : await previewField("unavailableText", command.unavailableText)),
  ...(command.usageText === undefined ? {} : await previewField("usageText", command.usageText)),
  ...(command.legacyFallback === true ? { legacyFallback: true } : {}),
  ...(command.legacyKind === undefined ? {} : { legacyKind: command.legacyKind }),
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
  left.responseType === right.responseType &&
  JSON.stringify(left.variableAction) === JSON.stringify(right.variableAction) &&
  left.legacyFallback === right.legacyFallback &&
  left.legacyKind === right.legacyKind &&
  extraTemplateKeys.every((key) => left[key] === right[key]);

const extraTemplatesOf = (value: Pick<TextCommand, typeof extraTemplateKeys[number] | "legacyFallback" | "legacyKind">): Record<string, string | boolean> => {
  const entries: [string, string | boolean][] = [];
  for (const key of extraTemplateKeys) {
    const template = value[key];
    if (template !== undefined) entries.push([key, template]);
  }
  if (value.legacyFallback === true) entries.push(["legacyFallback", true]);
  if (value.legacyKind !== undefined) entries.push(["legacyKind", value.legacyKind]);
  return Object.fromEntries(entries);
};

const storedExtraTemplates = (value: unknown): Pick<TextCommand, typeof extraTemplateKeys[number] | "legacyFallback" | "legacyKind"> => {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) as unknown : null;
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const templates: Partial<Record<(typeof extraTemplateKeys)[number], string>> & { legacyFallback?: true; legacyKind?: "uptime" | "followage" } = {};
  for (const key of extraTemplateKeys) {
    const template: unknown = Reflect.get(parsed, key);
    if (typeof template === "string") templates[key] = template;
  }
  if (Reflect.get(parsed, "legacyFallback") === true) templates.legacyFallback = true;
  const legacyKind: unknown = Reflect.get(parsed, "legacyKind");
  if (legacyKind === "uptime" || legacyKind === "followage") templates.legacyKind = legacyKind;
  return templates;
};

const succeeded = (): TextCommandMutationResult => ({ ok: true });

const failed = (
  reason: Exclude<TextCommandMutationResult, { ok: true }>['reason'],
  conflict?: TextCommandAliasConflict,
  current?: TextCommand,
): TextCommandMutationResult => ({
  ok: false,
  reason,
  ...(conflict === undefined ? {} : { conflict }),
  ...(current === undefined ? {} : { current }),
});

const runMutation = async (
  db: D1Database,
  prepareModuleAudit: PrepareModuleAudit | undefined,
  mutation: D1PreparedStatement,
  audit: Parameters<PrepareModuleAudit>[0],
  changedAt: string,
  sideEffects: readonly D1PreparedStatement[] = [],
): Promise<number> => {
  if (prepareModuleAudit === undefined) {
    if (sideEffects.length === 0) return (await mutation.run()).meta.changes;
    const results = await db.batch([mutation, ...sideEffects]);
    return results[0]?.meta.changes ?? 0;
  }
  const results = await db.batch([mutation, prepareModuleAudit(audit, changedAt), ...sideEffects]);
  return results[0]?.meta.changes ?? 0;
};

interface TextCommandRow {
  channel_id: string;
  command_name: string;
  response_text: string;
  kind: TextCommandKind;
  enabled: number;
  minimum_level: "everyone" | "subscriber" | "vip" | "moderator" | "broadcaster";
  cooldown_seconds: number;
  aliases_json: string;
  user_cooldown_seconds: number;
  stream_condition: TextCommandStreamCondition;
  response_type: TextCommandResponseType;
  template_fields_json: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  use_count: number;
  variable_name: string | null;
  variable_operation: ChannelVariableOperation | null;
  variable_amount: number | null;
}

const mapTextCommand = (row: TextCommandRow): TextCommand => ({
  channelId: row.channel_id,
  name: row.command_name,
  text: row.response_text,
  kind: row.kind,
  ...storedExtraTemplates(row.template_fields_json),
  enabled: row.enabled === 1,
  minimumTier: row.minimum_level,
  cooldownSeconds: row.cooldown_seconds,
  aliases: JSON.parse(row.aliases_json) as string[],
  userCooldownSeconds: row.user_cooldown_seconds,
  streamCondition: row.stream_condition,
  responseType: row.response_type,
  variableAction: row.variable_name === null || row.variable_operation === null || row.variable_amount === null
    ? null
    : { name: row.variable_name, operation: row.variable_operation, amount: row.variable_amount },
  useCount: row.use_count,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revision: row.revision,
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
           SELECT 1 FROM text_command_aliases AS existing_alias
            WHERE existing_alias.channel_id = other.channel_id
              AND existing_alias.command_name = other.command_name
              AND existing_alias.alias = proposed.value
         )
      WHERE other.channel_id = ? AND (? IS NULL OR other.command_name <> ?)
      ORDER BY CASE proposed.field WHEN 'name' THEN 0 ELSE 1 END, other.command_name
      LIMIT 1`,
  ).bind(name, JSON.stringify(aliases), channelId, excludeName, excludeName).first<AliasConflictRow>();
  return row === null ? null : { field: row.field, trigger: row.trigger, command: row.command };
};

export const textCommandSelectColumns = `channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
                                       aliases_json, user_cooldown_seconds, stream_condition, response_type,
                                       template_fields_json, last_used_at, created_at, updated_at, revision,
                                       use_count, variable_name, variable_operation, variable_amount`;

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
      `SELECT command.channel_id, command.command_name, command.response_text, command.kind, command.enabled,
              command.minimum_level, command.cooldown_seconds, command.aliases_json,
              command.user_cooldown_seconds, command.stream_condition, command.response_type,
              command.template_fields_json, command.last_used_at, command.created_at, command.updated_at,
              command.revision, command.use_count, command.variable_name, command.variable_operation, command.variable_amount
         FROM text_command_aliases AS alias
         JOIN text_commands AS command
           ON command.channel_id = alias.channel_id AND command.command_name = alias.command_name
        WHERE alias.channel_id = ? AND alias.alias = ?`,
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
    const extraTemplatesJson = JSON.stringify(extraTemplatesOf(input));
    const mutation = db.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
         aliases_json, user_cooldown_seconds, stream_condition, response_type,
         template_fields_json, variable_name, variable_operation, variable_amount,
         last_used_at, created_at, updated_at, revision)
       SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM text_commands AS other
           WHERE other.channel_id = ? AND other.command_name = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM text_commands AS other
             WHERE other.channel_id = ?
               AND (other.command_name = ? OR other.command_name IN (SELECT value FROM json_each(?)))
          )
          AND NOT EXISTS (
            SELECT 1 FROM text_command_aliases AS existing_alias
             WHERE existing_alias.channel_id = ?
               AND (existing_alias.alias = ? OR existing_alias.alias IN (SELECT value FROM json_each(?)))
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
      extraTemplatesJson,
      input.variableAction?.name ?? null,
      input.variableAction?.operation ?? null,
      input.variableAction?.amount ?? null,
      input.now,
      input.now,
      initialTextCommandRevision(input.now),
      input.channelId,
      input.name,
      input.channelId,
      input.name,
      aliasesJson,
      input.channelId,
      input.name,
      aliasesJson,
      ...authorization.values,
    );
    const after: TextCommand = {
      channelId: input.channelId,
      name: input.name,
      text: input.text,
      kind: input.kind,
      ...extraTemplatesOf(input),
      enabled: true,
      minimumTier,
      cooldownSeconds: input.cooldownSeconds,
      aliases,
      userCooldownSeconds,
      streamCondition,
      responseType,
      variableAction: input.variableAction ?? null,
      useCount: 0,
      lastUsedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      revision: initialTextCommandRevision(input.now),
    };
    const aliasWrites = aliases.map((alias) => db.prepare(
      `INSERT INTO text_command_aliases (channel_id, alias, command_name)
       SELECT ?, ?, ? WHERE changes() > 0`,
    ).bind(input.channelId, alias, input.name));
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.created" satisfies AuditAction,
      before: null,
      after: await auditValues(after),
    }, input.now, aliasWrites);
    if (changes > 0) return succeeded();
    if (await this.find(input.channelId, input.name) !== null) return failed("already_exists");
    const conflict = await aliasConflict(db, input.channelId, input.name, aliases, null);
    return conflict === null ? failed("not_authorized") : failed("alias_conflict", conflict);
  },

  async change(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult> {
    const before = await this.find(input.channelId, input.name);
    if (before === null) return failed("not_found");
    const expectedRevision = input.expectedRevision ?? before.revision;
    if (expectedRevision !== before.revision) return failed("conflict", undefined, before);
    if (input.onlyToggle !== true && input.newName !== input.name &&
        await this.find(input.channelId, input.newName) !== null) {
      return failed("already_exists");
    }
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const minimumTier = input.minimumTier ?? before.minimumTier;
    const extraTemplates = extraTemplatesOf({ ...before, ...input });
    const extraTemplatesJson = JSON.stringify(extraTemplates);
    const mutation = input.onlyToggle === true
      ? db.prepare(
        `UPDATE text_commands
            SET enabled = ?, updated_at = ?, revision = revision + 1
          WHERE channel_id = ? AND command_name = ? AND revision = ?
            ${authorization.sql}`,
      ).bind(
        input.enabled ? 1 : 0,
        input.now,
        input.channelId,
        input.name,
        expectedRevision,
        ...authorization.values,
      )
      : db.prepare(
        `UPDATE text_commands
            SET command_name = ?, response_text = ?, kind = ?, enabled = ?, minimum_level = ?, cooldown_seconds = ?,
              aliases_json = ?, user_cooldown_seconds = ?, stream_condition = ?, response_type = ?,
                template_fields_json = ?, variable_name = ?, variable_operation = ?, variable_amount = ?,
                updated_at = ?, revision = revision + 1
          WHERE channel_id = ? AND command_name = ? AND revision = ?
            AND (command_name = ? OR NOT EXISTS (
              SELECT 1 FROM text_commands AS other
               WHERE other.channel_id = ? AND other.command_name = ?
            ))
            AND NOT EXISTS (
              SELECT 1 FROM text_commands AS other
               WHERE other.channel_id = ? AND other.command_name <> ?
                 AND (other.command_name = ? OR other.command_name IN (SELECT value FROM json_each(?)))
            )
            AND NOT EXISTS (
              SELECT 1 FROM text_command_aliases AS existing_alias
               WHERE existing_alias.channel_id = ? AND existing_alias.command_name <> ?
                 AND (existing_alias.alias = ? OR existing_alias.alias IN (SELECT value FROM json_each(?)))
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
        extraTemplatesJson,
        input.variableAction?.name ?? null,
        input.variableAction?.operation ?? null,
        input.variableAction?.amount ?? null,
        input.now,
        input.channelId,
        input.name,
        expectedRevision,
        input.name,
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
      ? { ...before, enabled: input.enabled, updatedAt: input.now, revision: before.revision + 1 }
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
        variableAction: input.variableAction ?? null,
        useCount: before.useCount,
        ...extraTemplates,
        updatedAt: input.now,
        revision: before.revision + 1,
      };
    const sideEffects: D1PreparedStatement[] = [];
    if (input.onlyToggle !== true) {
      sideEffects.push(db.prepare(
        `DELETE FROM text_command_aliases
          WHERE channel_id = ? AND command_name = ?
            AND EXISTS (
            SELECT 1 FROM text_commands
               WHERE channel_id = ? AND command_name = ? AND revision = ? AND aliases_json = ?
            )`,
      ).bind(
        input.channelId,
        input.newName,
        input.channelId,
        input.newName,
        expectedRevision + 1,
        JSON.stringify(input.aliases),
      ));
      sideEffects.push(...input.aliases.map((alias) => db.prepare(
        `INSERT INTO text_command_aliases (channel_id, alias, command_name)
         SELECT ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM text_commands
            WHERE channel_id = ? AND command_name = ? AND revision = ? AND aliases_json = ?
         )`,
      ).bind(
        input.channelId,
        alias,
        input.newName,
        input.channelId,
        input.newName,
        expectedRevision + 1,
        JSON.stringify(input.aliases),
      )));
      if (input.newName !== input.name) {
        // Cooldowns are command-name keyed; renames intentionally discard them.
        sideEffects.push(db.prepare(
          `DELETE FROM text_command_user_cooldowns
            WHERE channel_id = ? AND command_name = ?
              AND EXISTS (
                SELECT 1 FROM text_commands
                 WHERE channel_id = ? AND command_name = ? AND revision = ?
              )`,
        ).bind(input.channelId, input.name, input.channelId, input.newName, expectedRevision + 1));
      }
    }
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.updated" satisfies AuditAction,
      before: await auditValues(before),
      after: await auditValues(after),
    }, input.now, sideEffects);
    if (changes > 0) return succeeded();

    const current = await this.find(input.channelId, input.name);
    if (current !== null && current.revision !== expectedRevision) return failed("conflict", undefined, current);
    const nameConflict = input.newName === input.name ? null : await this.find(input.channelId, input.newName);
    if (nameConflict !== null) return failed("already_exists");
    const conflict = await aliasConflict(db, input.channelId, input.newName, input.aliases, input.name);
    if (conflict !== null) return failed("alias_conflict", conflict);
    if (current === null) return failed("not_found");
    return sameMutationValues(current, before)
      ? failed("not_authorized")
      : failed("conflict", undefined, current);
  },

  async delete(
    channelId: string,
    name: string,
    expectedRevision: number,
    actor: TextCommandActor,
    now: string,
  ): Promise<TextCommandMutationResult> {
    const before = await this.find(channelId, name);
    if (before === null) return failed("not_found");
    if (before.revision !== expectedRevision) return failed("conflict", undefined, before);
    const authorization = authorizeMutation(channelId, actor, now);
    const mutation = db.prepare(
      `DELETE FROM text_commands
        WHERE channel_id = ? AND command_name = ?
          AND revision = ?
          AND response_text = ? AND kind = ? AND enabled = ?
          AND minimum_level = ? AND cooldown_seconds = ? AND aliases_json = ?
          AND user_cooldown_seconds = ? AND stream_condition = ? AND response_type = ?
          AND template_fields_json = ?
          AND variable_name IS ? AND variable_operation IS ? AND variable_amount IS ?
          ${authorization.sql}`,
    ).bind(
      channelId,
      name,
      expectedRevision,
      before.text,
      before.kind,
      before.enabled ? 1 : 0,
      before.minimumTier,
      before.cooldownSeconds,
      JSON.stringify(before.aliases),
      before.userCooldownSeconds,
      before.streamCondition,
      before.responseType,
      JSON.stringify(extraTemplatesOf(before)),
      before.variableAction?.name ?? null,
      before.variableAction?.operation ?? null,
      before.variableAction?.amount ?? null,
      ...authorization.values,
    );
    const cleanupCooldowns = db.prepare(
      `DELETE FROM text_command_user_cooldowns
        WHERE channel_id = ? AND command_name = ? AND changes() > 0`,
    ).bind(channelId, name);
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId,
      moduleId: MODULE_ID,
      action: "text_commands.command.removed" satisfies AuditAction,
      before: await auditValues(before),
      after: null,
    }, now, [cleanupCooldowns]);
    if (changes > 0) return succeeded();
    const current = await this.find(channelId, name);
    if (current === null) return failed("not_found");
    if (current.revision !== expectedRevision) return failed("conflict", undefined, current);
    return failed(sameMutationValues(current, before) ? "not_authorized" : "conflict");
  },

  async claim(
    channelId: string,
    name: string,
    now: string,
    userId?: string | null,
    userCooldownSeconds = 0,
    prepareVariableChange?: PrepareTextCommandVariableChange,
    variableAmount?: number | null,
    knownCommand?: TextCommand,
  ): Promise<TextCommandClaim | null> {
    const commandBeforeClaim = knownCommand ?? null;
    const action = commandBeforeClaim?.variableAction ?? null;
    const variableChange = action !== null && prepareVariableChange !== undefined &&
      (action.operation !== "set_argument" || variableAmount !== null && variableAmount !== undefined)
      ? prepareVariableChange(channelId, {
        name: action.name,
        operation: action.operation,
        amount: action.operation === "set_argument" ? variableAmount ?? 0 : action.amount,
      }, now, { commandName: name, revision: knownCommand?.revision ?? 0, userId: userId ?? null })
      : null;
    const claim = db.prepare(
      `UPDATE text_commands
          SET last_used_at = ?, updated_at = ?, use_count = use_count + 1
        WHERE channel_id = ? AND command_name = ?
          AND enabled = 1
          AND (last_used_at IS NULL OR julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)
          AND (? IS NULL OR revision = ?)
          AND (? IS NULL OR user_cooldown_seconds = 0 OR NOT EXISTS (
            SELECT 1 FROM text_command_user_cooldowns AS user_cooldown
             WHERE user_cooldown.channel_id = ? AND user_cooldown.command_name = ? AND user_cooldown.user_id = ?
               AND julianday(user_cooldown.last_used_at) > julianday(?) - text_commands.user_cooldown_seconds / 86400.0
          ))
          ${variableChange === null ? "" : "AND changes() > 0"}
        RETURNING ${textCommandSelectColumns}`,
    ).bind(now, now, channelId, name, now, knownCommand?.revision ?? null, knownCommand?.revision ?? null,
      userId ?? null, channelId, name, userId ?? null, now);

    const statements: D1PreparedStatement[] = variableChange === null ? [claim] : [variableChange, claim];
    if (userCooldownSeconds > 0 && userId !== undefined && userId !== null) {
      statements.push(commandBeforeClaim !== null && variableChange !== null
        ? db.prepare(
          `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
           SELECT ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM text_commands
               WHERE channel_id = ? AND command_name = ? AND revision = ?
                 AND last_used_at = ? AND use_count = ?
            )
           ON CONFLICT (channel_id, command_name, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
        ).bind(channelId, name, userId, now, channelId, name, commandBeforeClaim.revision, now, commandBeforeClaim.useCount + 1)
        : db.prepare(
          `INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
           SELECT ?, ?, ?, ? WHERE changes() > 0
           ON CONFLICT (channel_id, command_name, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
        ).bind(channelId, name, userId, now));
    }
    const results = statements.length === 1 ? [await claim.run()] : await db.batch(statements);
    const claimResult = results[variableChange === null ? 0 : 1];
    if (claimResult === undefined) throw new Error("Command claim returned no result.");
    const globalChanges = claimResult.meta.changes;

    const current = claimResult.results[0] !== undefined
      ? mapTextCommand(claimResult.results[0] as TextCommandRow)
      : commandBeforeClaim === null
        ? await this.find(channelId, name)
        : globalChanges > 0
          ? { ...commandBeforeClaim, lastUsedAt: now, updatedAt: now, useCount: commandBeforeClaim.useCount + 1 }
          : await this.find(channelId, name);
    if (current === null) return null;
    if (globalChanges > 0) {
      const actionResult = variableChange === null ? undefined : results[0];
      if (variableChange !== null && (actionResult?.meta.changes ?? 0) === 0) {
        return {
          command: await this.find(channelId, name) ?? current,
          claimed: false,
          reason: "variable_update_failed",
        };
      }
      const changedResult = actionResult?.results[0];
      const changed = typeof changedResult === "object" && changedResult !== null &&
          "name" in changedResult && typeof changedResult.name === "string" &&
          "value" in changedResult && typeof changedResult.value === "number"
        ? { name: changedResult.name, value: changedResult.value }
        : undefined;
      return { command: current, claimed: true, ...(changed === undefined ? {} : { changedVariable: changed }) };
    }

    if (commandBeforeClaim !== null && current.revision !== commandBeforeClaim.revision) {
      return { command: current, claimed: false, stale: true };
    }

    const globalRemaining = cooldownRemaining(current.lastUsedAt, now, current.cooldownSeconds);
    if (globalRemaining > 0) {
      return { command: current, claimed: false, reason: "cooldown", remainingSeconds: globalRemaining };
    }
    if (variableChange !== null && (userId === undefined || userId === null || current.userCooldownSeconds === 0)) {
      return { command: current, claimed: false, reason: "variable_update_failed" };
    }
    if (userId === undefined || userId === null || current.userCooldownSeconds === 0) {
      return { command: current, claimed: false, reason: "cooldown", remainingSeconds: globalRemaining };
    }
    const userCooldown = await db.prepare(
      `SELECT last_used_at
         FROM text_command_user_cooldowns
        WHERE channel_id = ? AND command_name = ? AND user_id = ?`,
    ).bind(channelId, name, userId).first<UserCooldownRow>();
    const userRemaining = cooldownRemaining(userCooldown?.last_used_at ?? null, now, current.userCooldownSeconds);
    if (variableChange !== null && userRemaining === 0) return { command: current, claimed: false, reason: "variable_update_failed" };
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
      (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at, revision)
     SELECT ?, 'befehle', '', 'list', 1, 'everyone', 5, NULL, ?, ?, ?
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
    initialTextCommandRevision(now),
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
