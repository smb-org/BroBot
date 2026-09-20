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

const auditWerte = (befehl: Pick<Textbefehl, "name" | "text" | "cooldownSekunden">) => ({
  name: befehl.name,
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
  cooldown_seconds: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

const mapTextbefehl = (row: TextbefehlRow): Textbefehl => ({
  channelId: row.channel_id,
  name: row.command_name,
  text: row.response_text,
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
      `SELECT channel_id, command_name, response_text, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM textbefehle_commands
        WHERE channel_id = ?
        ORDER BY command_name`,
    ).bind(channelId).all<TextbefehlRow>();
    return result.results.map(mapTextbefehl);
  },

  async finden(channelId: string, name: string): Promise<Textbefehl | null> {
    const row = await db.prepare(
      `SELECT channel_id, command_name, response_text, cooldown_seconds,
              last_used_at, created_at, updated_at
         FROM textbefehle_commands
        WHERE channel_id = ? AND command_name = ?`,
    ).bind(channelId, name).first<TextbefehlRow>();
    return row === null ? null : mapTextbefehl(row);
  },

  async anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    if (await this.finden(input.channelId, input.name) !== null) return fehlgeschlagen("existiert");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const mutation = db.prepare(
      `INSERT INTO textbefehle_commands
        (channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, NULL, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM textbefehle_commands
           WHERE channel_id = ? AND command_name = ?
        )
        ${authorization.sql}`,
    ).bind(
      input.channelId,
      input.name,
      input.text,
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
      after: auditWerte(input),
    }, input.now);
    if (changes > 0) return erfolgreich();
    return fehlgeschlagen(await this.finden(input.channelId, input.name) === null ? "nicht_berechtigt" : "existiert");
  },

  async aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis> {
    const before = await this.finden(input.channelId, input.name);
    if (before === null) return fehlgeschlagen("nicht_gefunden");
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const mutation = db.prepare(
      `UPDATE textbefehle_commands
          SET response_text = ?, cooldown_seconds = ?, updated_at = ?
        WHERE channel_id = ? AND command_name = ?
          ${authorization.sql}`,
    ).bind(
      input.text,
      input.cooldownSekunden,
      input.now,
      input.channelId,
      input.name,
      ...authorization.values,
    );
    const changes = await mutationAusfuehren(db, prepareModuleAudit, mutation, {
      channelId: input.channelId,
      moduleId: MODULE_ID,
      action: "textbefehle.befehl.geändert",
      before: auditWerte(before),
      after: auditWerte({ ...before, text: input.text, cooldownSekunden: input.cooldownSekunden }),
    }, input.now);
    if (changes > 0) return erfolgreich();
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
          AND (last_used_at IS NULL OR julianday(last_used_at) <= julianday(?) - cooldown_seconds / 86400.0)`,
    ).bind(now, now, channelId, name, now).run();
    const befehl = await this.finden(channelId, name);
    return befehl === null ? null : { befehl, beansprucht: result.meta.changes > 0 };
  },
});
