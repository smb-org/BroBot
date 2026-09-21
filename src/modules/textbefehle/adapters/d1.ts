import type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "../contracts";
import { kuerzeAuf200Zeichen, type AuthorizeModuleMutation, type PrepareModuleAudit } from "../contract";
import type { TextbefehlMutationsergebnis, TextbefehlRepository } from "../repository";

const MODULE_ID = "textbefehle";

const auditWerte = (befehl: Pick<Textbefehl, "name" | "text" | "art" | "enabled" | "mindeststufe" | "cooldownSekunden">) => ({
  name: befehl.name,
  art: befehl.art,
  enabled: befehl.enabled,
  mindeststufe: befehl.mindeststufe,
  text: kuerzeAuf200Zeichen(befehl.text),
  cooldownSekunden: befehl.cooldownSekunden,
});

const erfolgreich = (): TextbefehlMutationsergebnis => ({ ok: true });

const fehlgeschlagen = (grund: Exclude<TextbefehlMutationsergebnis, { ok: true }>["grund"]): TextbefehlMutationsergebnis => ({
  ok: false,
  grund,
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
  art: "text" | "liste";
  enabled: number;
  minimum_level: "alle" | "abonnent" | "vip" | "moderator" | "broadcaster";
  cooldown_seconds: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapTextbefehl = (row: TextbefehlRow): Textbefehl => ({
  channelId: row.channel_id,
  name: row.command_name,
  text: row.response_text,
  art: row.art,
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
      `SELECT channel_id, command_name, response_text, art, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM textbefehle_commands
        WHERE channel_id = ?
        ORDER BY command_name`,
    ).bind(channelId).all<TextbefehlRow>();
    return result.results.map(mapTextbefehl);
  },

  async finden(channelId: string, name: string): Promise<Textbefehl | null> {
    const row = await db.prepare(
      `SELECT channel_id, command_name, response_text, art, enabled, minimum_level, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM textbefehle_commands
        WHERE channel_id = ? AND command_name = ?`,
    ).bind(channelId, name).first<TextbefehlRow>();
    return row === null ? null : mapTextbefehl(row);
  },

  async anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    if (await this.finden(input.channelId, input.name) !== null) return fehlgeschlagen("existiert");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const mindeststufe = input.mindeststufe ?? "alle";
    const mutation = db.prepare(
      `INSERT INTO textbefehle_commands
        (channel_id, command_name, response_text, art, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM textbefehle_commands
           WHERE channel_id = ? AND command_name = ?
        )
        ${authorization.sql}`,
    ).bind(
      input.channelId,
      input.name,
      input.text,
      input.art,
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
      action: "textbefehle.befehl.angelegt",
      before: null,
      after: auditWerte({ ...input, mindeststufe, enabled: true }),
    }, input.now);
    if (changes > 0) return erfolgreich();
    return fehlgeschlagen(await this.finden(input.channelId, input.name) === null ? "nicht_berechtigt" : "existiert");
  },

  async aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    const before = await this.finden(input.channelId, input.name);
    if (before === null) return fehlgeschlagen("nicht_gefunden");
    if (input.neuerName !== input.name && await this.finden(input.channelId, input.neuerName) !== null) {
      return fehlgeschlagen("existiert");
    }
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const mindeststufe = input.mindeststufe ?? before.mindeststufe;
    const mutation = db.prepare(
      `UPDATE textbefehle_commands
          SET command_name = ?, response_text = ?, enabled = ?, minimum_level = ?, cooldown_seconds = ?, updated_at = ?
        WHERE channel_id = ? AND command_name = ?
          AND (? = command_name OR NOT EXISTS (
            SELECT 1 FROM textbefehle_commands
             WHERE channel_id = ? AND command_name = ?
          ))
          ${authorization.sql}`,
    ).bind(
      input.neuerName,
      input.text,
      input.enabled ? 1 : 0,
      mindeststufe,
      input.cooldownSekunden,
      input.now,
      input.channelId,
      input.name,
      input.neuerName,
      input.channelId,
      input.neuerName,
      ...authorization.values,
    );
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "textbefehle.befehl.geändert",
      before: auditWerte(before),
      after: auditWerte({
        ...before,
        name: input.neuerName,
        text: input.text,
        enabled: input.enabled,
        mindeststufe,
        cooldownSekunden: input.cooldownSekunden,
      }),
    }, input.now);
    if (changes > 0) return erfolgreich();
    if (await this.finden(input.channelId, input.neuerName) !== null && input.neuerName !== input.name) {
      return fehlgeschlagen("existiert");
    }
    return fehlgeschlagen(await this.finden(input.channelId, input.name) === null ? "nicht_gefunden" : "nicht_berechtigt");
  },

  async loeschen(channelId: string, name: string, actor: TextbefehlAkteur, now: string): Promise<TextbefehlMutationsergebnis> {
    const before = await this.finden(channelId, name);
    if (before === null) return fehlgeschlagen("nicht_gefunden");
    const authorization = authorizeMutation(channelId, actor, now);
    const mutation = db.prepare(
      `DELETE FROM textbefehle_commands
        WHERE channel_id = ? AND command_name = ?
          ${authorization.sql}`,
    ).bind(channelId, name, ...authorization.values);
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId,
      moduleId: MODULE_ID,
      action: "textbefehle.befehl.entfernt",
      before: auditWerte(before),
      after: null,
    }, now);
    if (changes > 0) return erfolgreich();
    return fehlgeschlagen(await this.finden(channelId, name) === null ? "nicht_gefunden" : "nicht_berechtigt");
  },

  async beanspruchen(channelId: string, name: string, now: string): Promise<TextbefehlBeanspruchung | null> {
    const result = await db.prepare(
      `UPDATE textbefehle_commands
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
): Promise<void> => {
  const authorization = authorizeMutation(channelId, actor, now);
  await db.prepare(
    `INSERT INTO textbefehle_commands
      (channel_id, command_name, response_text, art, enabled, minimum_level, cooldown_seconds, last_used_at, created_at, updated_at)
     SELECT ?, 'befehle', '', 'liste', 1, 'alle', 5, NULL, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM textbefehle_commands
         WHERE channel_id = ? AND command_name = 'befehle'
      )
      ${authorization.sql}`,
  ).bind(
    channelId,
    now,
    now,
    channelId,
    ...authorization.values,
  ).run();
};
