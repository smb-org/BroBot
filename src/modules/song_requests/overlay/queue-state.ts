import type { JsonObject } from "../../contract";
import { buildSongRequestQueueState, type SongRequestQueueEntry, type SongRequestQueueState } from "../domain/queue-state";
import { formatSongRequestTrack } from "../domain/track-display";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseSongRequestQueueConfig = (raw: unknown): Record<string, never> | null => {
  const input = record(raw);
  return input !== null && Object.keys(input).length === 0 ? {} : null;
};

export const parseSongRequestQueueState = (raw: unknown): SongRequestQueueState | null => {
  const input = record(raw);
  if (input === null || !Number.isSafeInteger(input.revision) || !Number.isSafeInteger(input.rowCount) || !Array.isArray(input.rows)) return null;
  const rows: SongRequestQueueEntry[] = [];
  for (const rawRow of input.rows.slice(0, 20)) {
    const row = record(rawRow);
    if (row === null || typeof row.title !== "string" || typeof row.requester !== "string" ||
        row.requestType !== "vote" && row.requestType !== "bot_points" && row.requestType !== "free" && row.requestType !== "channel_points") return null;
    rows.push({ title: row.title, requester: row.requester, requestType: row.requestType });
  }
  return buildSongRequestQueueState({
    revision: input.revision as number,
    rowCount: input.rowCount as number,
    rows,
  });
};

export const mergeSongRequestQueueState = (
  current: Readonly<Record<string, unknown>> | null,
  incoming: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const previous = parseSongRequestQueueState(current);
  const next = parseSongRequestQueueState(incoming);
  if (next === null || previous !== null && next.revision < previous.revision) return current ?? {};
  return next as unknown as Readonly<Record<string, unknown>>;
};

export const songRequestQueueStateJson = (state: SongRequestQueueState): JsonObject => state as unknown as JsonObject;

/** Reads BroBot's ledger for the current round. Raw SQL on purpose: overlay code may not import adapters. */
export const readSongRequestQueueState = async (db: D1Database, channelId: string): Promise<JsonObject> => {
  const [module, stream, revision] = await Promise.all([
    db.prepare("SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests'")
      .bind(channelId).first<{ enabled: number; settings: string }>(),
    db.prepare("SELECT state, stream_id FROM channel_stream_state WHERE channel_id = ?")
      .bind(channelId).first<{ state: string; stream_id: string | null }>(),
    db.prepare("SELECT revision FROM panel_resource_revisions WHERE channel_id = ? AND resource = 'module:song_requests:requests'")
      .bind(channelId).first<{ revision: number }>(),
  ]);
  let settings: Record<string, unknown> | null = null;
  try { settings = record(JSON.parse(module?.settings ?? "{}")); }
  catch { /* Invalid settings use the safe default overlay size. */ }
  const rowCount = typeof settings?.queueOverlayRows === "number" ? settings.queueOverlayRows : 10;
  let roundId: string | null = null;
  if (module?.enabled === 1) {
    if (stream?.state === "online") roundId = stream.stream_id;
    else if (stream?.state === "offline" && settings?.alsoOffline === true) {
      roundId = (await db.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
        .bind(channelId).first<{ round_id: string }>())?.round_id ?? null;
    }
  }
  const rows = roundId === null ? [] : (await db.prepare(
    `SELECT title, artists_json, album_name, requester_login, requester_display_name, request_type FROM song_requests
      WHERE channel_id = ? AND round_id = ?
        AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')
      ORDER BY created_at, id LIMIT 20`,
  ).bind(channelId, roundId).all<{
    title: string;
    artists_json: string;
    album_name: string | null;
    requester_login: string | null;
    requester_display_name: string | null;
    request_type: SongRequestQueueEntry["requestType"];
  }>()).results;
  return songRequestQueueStateJson(buildSongRequestQueueState({
    revision: revision?.revision ?? 0,
    rowCount,
    rows: rows.map((row) => {
      let artists: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.artists_json);
        if (Array.isArray(parsed)) artists = parsed.filter((artist): artist is string => typeof artist === "string");
      } catch { /* Empty legacy artist lists stay readable. */ }
      return {
        title: formatSongRequestTrack({ title: row.title, artists, albumName: row.album_name }),
        requester: row.requester_display_name ?? row.requester_login ?? "",
        requestType: row.request_type,
      };
    }),
  }));
};
