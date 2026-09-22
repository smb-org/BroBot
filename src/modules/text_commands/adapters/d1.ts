import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
} from "../contracts";
import { truncateTo200Chars, type AuthorizeModuleMutation, type PrepareModuleAudit } from "../contract";
import type { TextCommandMutationResult, TextCommandRepository } from "../repository";

const MODULE_ID = "text_commands";

const auditValues = (command: Pick<TextCommand, "name" | "text" | "kind" | "enabled" | "minimumTier" | "cooldownSeconds">) => ({
  name: command.name,
  kind: command.kind,
  enabled: command.enabled,
  minimumTier: command.minimumTier,
  text: truncateTo200Chars(command.text),
  cooldownSeconds: command.cooldownSeconds,
});

const sameMutationValues = (
  left: Pick<TextCommand, "name" | "text" | "kind" | "enabled" | "minimumTier" | "cooldownSeconds">,
  right: Pick<TextCommand, "name" | "text" | "kind" | "enabled" | "minimumTier" | "cooldownSeconds">,
): boolean => left.name === right.name &&
  left.text === right.text &&
  left.kind === right.kind &&
  left.enabled === right.enabled &&
  left.minimumTier === right.minimumTier &&
  left.cooldownSeconds === right.cooldownSeconds;

const succeeded = (): TextCommandMutationResult => ({ ok: true });

const failed = (reason: Exclude<TextCommandMutationResult, { ok: true }>["reason"]): TextCommandMutationResult => ({
  ok: false,
  reason: reason,
});

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
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createTextCommandRepository = (
  db: D1Database,
  authorizeMutation: AuthorizeModuleMutation,
  prepareModuleAudit?: PrepareModuleAudit,
): TextCommandRepository => ({
  async list(channelId: string): Promise<TextCommand[]> {
    const result = await db.prepare(
      `SELECT channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM text_commands
        WHERE channel_id = ?
        ORDER BY command_name`,
    ).bind(channelId).all<TextCommandRow>();
    return result.results.map(mapTextCommand);
  },

  async find(channelId: string, name: string): Promise<TextCommand | null> {
    const row = await db.prepare(
      `SELECT channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM text_commands
        WHERE channel_id = ? AND command_name = ?`,
    ).bind(channelId, name).first<TextCommandRow>();
    return row === null ? null : mapTextCommand(row);
  },

  async create(input: NewTextCommand, actor: TextCommandActor): Promise<TextCommandMutationResult> {
    if (await this.find(input.channelId, input.name) !== null) return failed("existiert");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const minimumTier = input.minimumTier ?? "everyone";
    const mutation = db.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM text_commands
           WHERE channel_id = ? AND command_name = ?
        )
        ${authorization.sql}`,
    ).bind(
      input.channelId,
      input.name,
      input.text,
      input.kind,
      minimumTier,
      input.cooldownSeconds,
      input.now,
      input.now,
      input.channelId,
      input.name,
      ...authorization.values,
    );
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.angelegt",
      before: null,
      after: auditValues({ ...input, minimumTier: minimumTier, enabled: true }),
    }, input.now);
    if (changes > 0) return succeeded();
    return failed(await this.find(input.channelId, input.name) === null ? "nicht_berechtigt" : "existiert");
  },

  async change(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult> {
    const before = await this.find(input.channelId, input.name);
    if (before === null) return failed("nicht_gefunden");
    if (input.onlyToggle !== true && input.newName !== input.name && await this.find(input.channelId, input.newName) !== null) {
      return failed("existiert");
    }
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const beforeMinimumTier = before.minimumTier;
    const minimumTier = input.minimumTier ?? beforeMinimumTier;
    const mutation = input.onlyToggle === true
      ? db.prepare(
        `UPDATE text_commands
            SET enabled = ?, updated_at = ?
          WHERE channel_id = ? AND command_name = ?
            AND response_text = ? AND kind = ? AND enabled = ?
            AND minimum_level = ? AND cooldown_seconds = ?
            ${authorization.sql}`,
      ).bind(
        input.enabled ? 1 : 0,
        input.now,
        input.channelId,
        input.name,
        before.text,
        before.kind,
        before.enabled ? 1 : 0,
        beforeMinimumTier,
        before.cooldownSeconds,
        ...authorization.values,
      )
      : db.prepare(
        `UPDATE text_commands
          SET command_name = ?, response_text = ?, kind = ?, enabled = ?, minimum_level = ?, cooldown_seconds = ?, updated_at = ?
          WHERE channel_id = ? AND command_name = ?
            AND response_text = ? AND kind = ? AND enabled = ?
            AND minimum_level = ? AND cooldown_seconds = ?
            AND (? = command_name OR NOT EXISTS (
              SELECT 1 FROM text_commands
               WHERE channel_id = ? AND command_name = ?
            ))
            ${authorization.sql}`,
      ).bind(
        input.newName,
        input.text,
        input.kind,
        input.enabled ? 1 : 0,
        minimumTier,
        input.cooldownSeconds,
        input.now,
        input.channelId,
        input.name,
        before.text,
        before.kind,
        before.enabled ? 1 : 0,
        beforeMinimumTier,
        before.cooldownSeconds,
        input.newName,
        input.channelId,
        input.newName,
        ...authorization.values,
      );
    const after = input.onlyToggle === true
      ? { ...before, enabled: input.enabled }
      : {
        ...before,
        name: input.newName,
        text: input.text,
        kind: input.kind,
        enabled: input.enabled,
        minimumTier: minimumTier,
        cooldownSeconds: input.cooldownSeconds,
      };
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.geändert",
      before: auditValues(before),
      after: auditValues(after),
    }, input.now);
    if (changes > 0) return succeeded();
    const current = await this.find(input.channelId, input.name);
    if (await this.find(input.channelId, input.newName) !== null && input.newName !== input.name) {
      return failed("existiert");
    }
    if (current === null) return failed("nicht_gefunden");
    return failed(sameMutationValues(current, before) ? "nicht_berechtigt" : "konflikt");
  },

  async delete(channelId: string, name: string, actor: TextCommandActor, now: string): Promise<TextCommandMutationResult> {
    const before = await this.find(channelId, name);
    if (before === null) return failed("nicht_gefunden");
    const authorization = authorizeMutation(channelId, actor, now);
    const mutation = db.prepare(
      `DELETE FROM text_commands
        WHERE channel_id = ? AND command_name = ?
          AND response_text = ? AND kind = ? AND enabled = ?
          AND minimum_level = ? AND cooldown_seconds = ?
          ${authorization.sql}`,
    ).bind(
      channelId,
      name,
      before.text,
      before.kind,
      before.enabled ? 1 : 0,
      before.minimumTier,
      before.cooldownSeconds,
      ...authorization.values,
    );
    const changes = await runMutation(db, prepareModuleAudit, mutation, {
      channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.entfernt",
      before: auditValues(before),
      after: null,
    }, now);
    if (changes > 0) return succeeded();
    const current = await this.find(channelId, name);
    if (current === null) return failed("nicht_gefunden");
    return failed(sameMutationValues(current, before) ? "nicht_berechtigt" : "konflikt");
  },

  async claim(channelId: string, name: string, now: string): Promise<TextCommandClaim | null> {
    const result = await db.prepare(
      `UPDATE text_commands
          SET last_used_at = ?, updated_at = ?
        WHERE channel_id = ? AND command_name = ?
          AND enabled = 1
          AND (last_used_at IS NULL OR julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)`,
    ).bind(now, now, channelId, name, now).run();
    const command = await this.find(channelId, name);
    return command === null ? null : { command: command, claimed: result.meta.changes > 0 };
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
      action: "text_commands.befehl.angelegt",
      before: null,
      after: { name: "befehle", kind: "list", enabled: true, minimumTier: "everyone", text: "", cooldownSeconds: 5 },
    }, now),
  ];
};
