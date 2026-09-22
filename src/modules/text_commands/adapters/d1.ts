import type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "../contracts";
import { kuerzeAuf200Zeichen, type AuthorizeModuleMutation, type PrepareModuleAudit } from "../contract";
import type { TextbefehlMutationsergebnis, TextbefehlRepository } from "../repository";

const MODULE_ID = "text_commands";

const auditWerte = (befehl: Pick<Textbefehl, "name" | "text" | "kind" | "enabled" | "mindeststufe" | "cooldownSekunden">) => ({
  name: befehl.name,
  kind: befehl.kind,
  enabled: befehl.enabled,
  mindeststufe: befehl.mindeststufe,
  text: kuerzeAuf200Zeichen(befehl.text),
  cooldownSekunden: befehl.cooldownSekunden,
});

const gleicheMutationswerte = (
  links: Pick<Textbefehl, "name" | "text" | "kind" | "enabled" | "mindeststufe" | "cooldownSekunden">,
  rechts: Pick<Textbefehl, "name" | "text" | "kind" | "enabled" | "mindeststufe" | "cooldownSekunden">,
): boolean => links.name === rechts.name &&
  links.text === rechts.text &&
  links.kind === rechts.kind &&
  links.enabled === rechts.enabled &&
  links.mindeststufe === rechts.mindeststufe &&
  links.cooldownSekunden === rechts.cooldownSekunden;

const erfolgreich = (): TextbefehlMutationsergebnis => ({ ok: true });

const fehlgeschlagen = (grund: Exclude<TextbefehlMutationsergebnis, { ok: true }>["reason"]): TextbefehlMutationsergebnis => ({
  ok: false,
  reason: grund,
});

const mutationAusfuehren = async (
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

interface TextbefehlRow {
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

const mapTextbefehl = (row: TextbefehlRow): Textbefehl => ({
  channelId: row.channel_id,
  name: row.command_name,
  text: row.response_text,
  kind: row.kind,
  enabled: row.enabled === 1,
  mindeststufe: row.minimum_level,
  cooldownSekunden: row.cooldown_seconds,
  zuletztVerwendetAt: row.last_used_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createTextbefehlRepository = (
  db: D1Database,
  authorizeMutation: AuthorizeModuleMutation,
  prepareModuleAudit?: PrepareModuleAudit,
): TextbefehlRepository => ({
  async auflisten(channelId: string): Promise<Textbefehl[]> {
    const result = await db.prepare(
      `SELECT channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM text_commands
        WHERE channel_id = ?
        ORDER BY command_name`,
    ).bind(channelId).all<TextbefehlRow>();
    return result.results.map(mapTextbefehl);
  },

  async finden(channelId: string, name: string): Promise<Textbefehl | null> {
    const row = await db.prepare(
      `SELECT channel_id, command_name, response_text, kind, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM text_commands
        WHERE channel_id = ? AND command_name = ?`,
    ).bind(channelId, name).first<TextbefehlRow>();
    return row === null ? null : mapTextbefehl(row);
  },

  async anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    if (await this.finden(input.channelId, input.name) !== null) return fehlgeschlagen("existiert");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const mindeststufe = input.mindeststufe ?? "everyone";
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
      mindeststufe,
      input.cooldownSekunden,
      input.now,
      input.now,
      input.channelId,
      input.name,
      ...authorization.values,
    );
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.angelegt",
      before: null,
      after: auditWerte({ ...input, mindeststufe, enabled: true }),
    }, input.now);
    if (changes > 0) return erfolgreich();
    return fehlgeschlagen(await this.finden(input.channelId, input.name) === null ? "nicht_berechtigt" : "existiert");
  },

  async aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    const before = await this.finden(input.channelId, input.name);
    if (before === null) return fehlgeschlagen("nicht_gefunden");
    if (input.nurSchalter !== true && input.neuerName !== input.name && await this.finden(input.channelId, input.neuerName) !== null) {
      return fehlgeschlagen("existiert");
    }
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const beforeMindeststufe = before.mindeststufe;
    const mindeststufe = input.mindeststufe ?? beforeMindeststufe;
    const mutation = input.nurSchalter === true
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
        beforeMindeststufe,
        before.cooldownSekunden,
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
        input.neuerName,
        input.text,
        input.kind,
        input.enabled ? 1 : 0,
        mindeststufe,
        input.cooldownSekunden,
        input.now,
        input.channelId,
        input.name,
        before.text,
        before.kind,
        before.enabled ? 1 : 0,
        beforeMindeststufe,
        before.cooldownSekunden,
        input.neuerName,
        input.channelId,
        input.neuerName,
        ...authorization.values,
      );
    const after = input.nurSchalter === true
      ? { ...before, enabled: input.enabled }
      : {
        ...before,
        name: input.neuerName,
        text: input.text,
        kind: input.kind,
        enabled: input.enabled,
        mindeststufe,
        cooldownSekunden: input.cooldownSekunden,
      };
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.geändert",
      before: auditWerte(before),
      after: auditWerte(after),
    }, input.now);
    if (changes > 0) return erfolgreich();
    const current = await this.finden(input.channelId, input.name);
    if (await this.finden(input.channelId, input.neuerName) !== null && input.neuerName !== input.name) {
      return fehlgeschlagen("existiert");
    }
    if (current === null) return fehlgeschlagen("nicht_gefunden");
    return fehlgeschlagen(gleicheMutationswerte(current, before) ? "nicht_berechtigt" : "konflikt");
  },

  async loeschen(channelId: string, name: string, actor: TextbefehlAkteur, now: string): Promise<TextbefehlMutationsergebnis> {
    const before = await this.finden(channelId, name);
    if (before === null) return fehlgeschlagen("nicht_gefunden");
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
      before.mindeststufe,
      before.cooldownSekunden,
      ...authorization.values,
    );
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId,
      moduleId: MODULE_ID,
      action: "text_commands.befehl.entfernt",
      before: auditWerte(before),
      after: null,
    }, now);
    if (changes > 0) return erfolgreich();
    const current = await this.finden(channelId, name);
    if (current === null) return fehlgeschlagen("nicht_gefunden");
    return fehlgeschlagen(gleicheMutationswerte(current, before) ? "nicht_berechtigt" : "konflikt");
  },

  async beanspruchen(channelId: string, name: string, now: string): Promise<TextbefehlBeanspruchung | null> {
    const result = await db.prepare(
      `UPDATE text_commands
          SET last_used_at = ?, updated_at = ?
        WHERE channel_id = ? AND command_name = ?
          AND enabled = 1
          AND (last_used_at IS NULL OR julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)`,
    ).bind(now, now, channelId, name, now).run();
    const befehl = await this.finden(channelId, name);
    return befehl === null ? null : { befehl, beansprucht: result.meta.changes > 0 };
  },
});

/** Legt den eingebauten Listenbefehl beim Aktivieren einmalig als normale Zeile an. */
export const initialisiereListenbefehl = async (
  db: D1Database,
  channelId: string,
  actor: TextbefehlAkteur,
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
      after: { name: "befehle", kind: "list", enabled: true, mindeststufe: "everyone", text: "", cooldownSekunden: 5 },
    }, now),
  ];
};
