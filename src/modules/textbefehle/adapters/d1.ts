import type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "../contracts";
import type { TextbefehlRepository } from "../repository";
import type { AuthorizeModuleMutation } from "../contract";

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

  async anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<boolean> {
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    try {
      const result = await db.prepare(
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
      ).run();
      return result.meta.changes > 0;
    } catch {
      return false;
    }
  },

  async aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<boolean> {
    const authorization = authorizeMutation(input.channelId, actor, input.now);
    const result = await db.prepare(
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
    ).run();
    return result.meta.changes > 0;
  },

  async loeschen(channelId: string, name: string, actor: TextbefehlAkteur, now: string): Promise<boolean> {
    const authorization = authorizeMutation(channelId, actor, now);
    const result = await db.prepare(
      `DELETE FROM textbefehle_commands
        WHERE channel_id = ? AND command_name = ?
          ${authorization.sql}`,
    ).bind(channelId, name, ...authorization.values).run();
    return result.meta.changes > 0;
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
