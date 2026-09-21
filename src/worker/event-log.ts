import type { ModuleDiagnostic } from "../modules/contract";

const EVENT_LOG_LIMIT = 500;
const EVENT_LOG_RETENTION_DAYS = 14;

export interface WrittenModuleDiagnostic {
  eventId: string;
  createdAt: string;
  moduleId: string;
  code: string;
  actorUserId: string | null;
}

/**
 * Schreibt Modulbegründungen sowie hostseitige Aktions- und
 * Ausgangsdiagnosen und hält den Bestand je Kanal in derselben D1-Transaktion
 * auf die neuesten 500 Zeilen.
 */
export const writeModuleDiagnostics = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
  triggerId: string,
  actorUserId: string | null,
  diagnostics: readonly ModuleDiagnostic[],
  now: string,
): Promise<WrittenModuleDiagnostic[]> => {
  if (diagnostics.length === 0) return [];
  const written = diagnostics.map((diagnostic): WrittenModuleDiagnostic => ({
    eventId: crypto.randomUUID(),
    createdAt: now,
    moduleId,
    code: diagnostic.code,
    actorUserId,
  }));
  const inserts = diagnostics.map((diagnostic, index) => db.prepare(
    `INSERT INTO event_log
      (event_id, channel_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    written[index]?.eventId ?? crypto.randomUUID(),
    channelId,
    now,
    moduleId,
    triggerId,
    diagnostic.code,
    JSON.stringify(diagnostic.detail ?? {}),
    actorUserId,
  ));
  const trim = db.prepare(
    `DELETE FROM event_log
      WHERE channel_id = ?
        AND event_id IN (
          SELECT event_id
            FROM event_log
           WHERE channel_id = ?
           ORDER BY created_at DESC, event_id DESC
           LIMIT -1 OFFSET ?
        )`,
  ).bind(channelId, channelId, EVENT_LOG_LIMIT);
  await db.batch([...inserts, trim]);
  return written;
};

/** Löscht Ereignisse, deren Erzeugungszeitpunkt länger als 14 Tage zurückliegt. */
export const purgeOldEventLogEntries = async (db: D1Database, now: string): Promise<void> => {
  const cutoff = new Date(
    Date.parse(now) - EVENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  await db.prepare(
    `DELETE FROM event_log
      WHERE created_at < ?`,
  ).bind(cutoff).run();
};
