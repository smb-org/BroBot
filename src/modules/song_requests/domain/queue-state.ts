type SongRequestQueueType = "vote" | "bot_points" | "free" | "channel_points";

export interface SongRequestQueueEntry {
  title: string;
  requester: string;
  requestType: SongRequestQueueType;
}

export interface SongRequestQueueState {
  revision: number;
  rowCount: number;
  rows: SongRequestQueueEntry[];
}

const truncate = (value: string, maximum: number): string => Array.from(value).slice(0, maximum).join("");
const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const buildSongRequestQueueState = (input: {
  revision: number;
  rowCount: number;
  rows: readonly SongRequestQueueEntry[];
}): SongRequestQueueState => {
  const rowCount = Math.max(2, Math.min(20, Math.trunc(input.rowCount)));
  let titleLength = 64;
  let requesterLength = 32;
  let rows = input.rows.slice(0, rowCount).map((row) => ({
    title: truncate(row.title, titleLength),
    requester: truncate(row.requester, requesterLength),
    requestType: row.requestType,
  }));
  const state = (): SongRequestQueueState => ({ revision: Math.max(0, Math.trunc(input.revision)), rowCount, rows });
  while (byteLength(state()) > 3_800 && (titleLength > 16 || requesterLength > 8)) {
    titleLength = Math.max(16, Math.floor(titleLength * 0.75));
    requesterLength = Math.max(8, Math.floor(requesterLength * 0.75));
    rows = input.rows.slice(0, rowCount).map((row) => ({
      title: truncate(row.title, titleLength),
      requester: truncate(row.requester, requesterLength),
      requestType: row.requestType,
    }));
  }
  while (rows.length > 2 && byteLength(state()) > 3_800) rows = rows.slice(0, -1);
  return state();
};
