import type { ModuleStreamState } from "../../modules/contract";

export type StoredStreamState = Exclude<ModuleStreamState, "unknown">;
export type StreamStateSource = "eventsub" | "helix";

interface StreamStateRow {
  state: StoredStreamState;
}

export const readChannelStreamState = async (
  db: D1Database,
  channelId: string,
): Promise<StoredStreamState | null> => {
  const row = await db.prepare(
    `SELECT state
       FROM channel_stream_state
      WHERE channel_id = ?`,
  ).bind(channelId).first<StreamStateRow>();
  return row?.state ?? null;
};

export const writeEventSubStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
     VALUES (?, ?, ?, 'eventsub')
     ON CONFLICT (channel_id) DO UPDATE
       SET state = excluded.state, changed_at = excluded.changed_at, source = 'eventsub'
     WHERE julianday(excluded.changed_at) >= julianday(channel_stream_state.changed_at)`,
  ).bind(channelId, state, changedAt).run();
  return result.meta.changes > 0;
};

export const writeHelixStreamStateIfUnknown = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
     VALUES (?, ?, ?, 'helix')
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, state, changedAt).run();
  return result.meta.changes > 0;
};
