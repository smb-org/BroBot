import type { SongRequestChapter, SongRequestChapterTrack } from "./contracts";

interface SongRequestChapterRow {
  id: string;
  channel_id: string;
  name: string;
  tracks_json: string;
  offer_in_cockpit: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface SongRequestChapterDraft {
  name: string;
  tracks: readonly SongRequestChapterTrack[];
  offerInCockpit: boolean;
}

const validTrack = (value: unknown): value is SongRequestChapterTrack => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const id: unknown = Reflect.get(value, "id");
  const title: unknown = Reflect.get(value, "title");
  const artists: unknown = Reflect.get(value, "artists");
  const coverUrl: unknown = Reflect.get(value, "coverUrl");
  return typeof id === "string" && /^[A-Za-z0-9]{1,64}$/u.test(id) &&
    typeof title === "string" && title.trim().length > 0 && Array.from(title).length <= 200 &&
    Array.isArray(artists) && artists.length <= 20 && artists.every((artist) => typeof artist === "string" && Array.from(artist).length <= 100) &&
    (coverUrl === null || (typeof coverUrl === "string" && coverUrl.startsWith("https://")));
};

const parseTracks = (json: string): SongRequestChapterTrack[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.length <= 20 && value.every(validTrack) ? value : [];
  } catch { return []; }
};

const mapChapter = (row: SongRequestChapterRow): SongRequestChapter => ({
  id: row.id,
  channelId: row.channel_id,
  name: row.name,
  tracks: parseTracks(row.tracks_json),
  offerInCockpit: row.offer_in_cockpit === 1,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const SONG_REQUEST_CHAPTER_COLUMNS = "id, channel_id, name, tracks_json, offer_in_cockpit, revision, created_at, updated_at";

export const readSongRequestChapter = async (
  db: D1Database,
  channelId: string,
  chapterId: string,
): Promise<SongRequestChapter | null> => {
  const row = await db.prepare(`SELECT ${SONG_REQUEST_CHAPTER_COLUMNS} FROM song_requests_chapters WHERE channel_id = ? AND id = ?`)
    .bind(channelId, chapterId).first<SongRequestChapterRow>();
  return row === null ? null : mapChapter(row);
};

export const listSongRequestChapters = async (
  db: D1Database,
  channelId: string,
  offeredOnly = false,
): Promise<SongRequestChapter[]> => {
  const rows = await db.prepare(
    `SELECT ${SONG_REQUEST_CHAPTER_COLUMNS} FROM song_requests_chapters WHERE channel_id = ? AND (? = 0 OR offer_in_cockpit = 1) ORDER BY name COLLATE NOCASE, id`,
  ).bind(channelId, Number(offeredOnly)).all<SongRequestChapterRow>();
  return rows.results.map(mapChapter);
};

export const saveSongRequestChapter = async (
  db: D1Database,
  channelId: string,
  chapterId: string | null,
  expectedRevision: number | null,
  draft: SongRequestChapterDraft,
  now: string,
): Promise<{ status: "saved"; chapter: SongRequestChapter } | { status: "missing" | "conflict" }> => {
  const id = chapterId ?? crypto.randomUUID();
  if (chapterId === null) {
    const inserted = await db.prepare(
      `INSERT INTO song_requests_chapters (channel_id, id, name, tracks_json, offer_in_cockpit, revision, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests')
       RETURNING ${SONG_REQUEST_CHAPTER_COLUMNS}`,
    ).bind(channelId, id, draft.name, JSON.stringify(draft.tracks), Number(draft.offerInCockpit), now, now, channelId)
      .first<SongRequestChapterRow>();
    return inserted === null ? { status: "conflict" } : { status: "saved", chapter: mapChapter(inserted) };
  }
  if (expectedRevision === null) return { status: "missing" };
  const updated = await db.prepare(
    `UPDATE song_requests_chapters SET name = ?, tracks_json = ?, offer_in_cockpit = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND id = ? AND revision = ?
     RETURNING ${SONG_REQUEST_CHAPTER_COLUMNS}`,
  ).bind(draft.name, JSON.stringify(draft.tracks), Number(draft.offerInCockpit), now, channelId, chapterId, expectedRevision)
    .first<SongRequestChapterRow>();
  if (updated !== null) return { status: "saved", chapter: mapChapter(updated) };
  return await readSongRequestChapter(db, channelId, chapterId) === null ? { status: "missing" } : { status: "conflict" };
};

export const deleteSongRequestChapter = async (
  db: D1Database,
  channelId: string,
  chapterId: string,
  expectedRevision: number,
): Promise<"deleted" | "missing" | "conflict"> => {
  const deleted = await db.prepare(
    "DELETE FROM song_requests_chapters WHERE channel_id = ? AND id = ? AND revision = ? RETURNING id",
  ).bind(channelId, chapterId, expectedRevision).first<{ id: string }>();
  if (deleted !== null) return "deleted";
  return await readSongRequestChapter(db, channelId, chapterId) === null ? "missing" : "conflict";
};

export const excludedSongRequestChapterTrackIds = async (
  db: D1Database,
  channelId: string,
  roundId: string,
  tracks: readonly SongRequestChapterTrack[],
  settings: { songCooldownEnabled: boolean; songCooldownOncePerRound: boolean; songCooldownMinutes: number },
  now: string,
): Promise<Set<string>> => {
  if (tracks.length === 0) return new Set();
  const ids = JSON.stringify(tracks.map(({ id }) => id));
  const played = await db.prepare(
    `SELECT DISTINCT track_id FROM song_requests
      WHERE channel_id = ? AND round_id = ? AND track_id IN (SELECT value FROM json_each(?))
        AND state NOT IN ('rejected', 'failed')`,
  ).bind(channelId, roundId, ids).all<{ track_id: string }>();
  const excluded = new Set(played.results.map(({ track_id }) => track_id));
  if (!settings.songCooldownEnabled) return excluded;
  const cooldown = settings.songCooldownOncePerRound
    ? await db.prepare(
      `SELECT DISTINCT track_id FROM song_requests
        WHERE channel_id = ? AND track_id IN (SELECT value FROM json_each(?)) AND submitted_at IS NOT NULL
          AND round_id = ? AND submitted_at <= ?`,
    ).bind(channelId, ids, roundId, now).all<{ track_id: string }>()
    : await db.prepare(
      `SELECT DISTINCT track_id FROM song_requests
        WHERE channel_id = ? AND track_id IN (SELECT value FROM json_each(?)) AND submitted_at IS NOT NULL
          AND submitted_at >= ? AND submitted_at <= ?`,
    ).bind(channelId, ids, new Date(Date.parse(now) - settings.songCooldownMinutes * 60_000).toISOString(), now)
      .all<{ track_id: string }>();
  for (const row of cooldown.results) excluded.add(row.track_id);
  return excluded;
};
