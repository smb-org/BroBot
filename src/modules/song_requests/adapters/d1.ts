import type { SpotifyTrack } from "../domain/track";
import { compactSpotifyTrack } from "../domain/track";

export interface SongRequestTrack {
  id: string;
  uri: string;
  title: string;
  artists: readonly string[];
  durationMs: number;
  explicit: boolean;
  coverUrl: string | null;
  spotifyUrl: string;
}

export type SongRequestState = "pending_review" | "approved" | "submitting" | "submitted" | "observed_playing" |
  "not_observed" | "outcome_unknown" | "rejected" | "removed" | "failed";

export interface SongRequestRow extends SongRequestTrack {
  requestId: string;
  source: "mod_vote" | "channel_points" | "points";
  requesterUserId: string | null;
  requesterLogin: string | null;
  requesterDisplayName: string | null;
  state: SongRequestState;
  operationId: string;
  failureReason: string | null;
  streamId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SongRequestSqlRow {
  id: string;
  source: SongRequestRow["source"];
  track_id: string;
  track_uri: string;
  title: string;
  artists_json: string;
  duration_ms: number;
  explicit: number;
  cover_url: string | null;
  spotify_url: string;
  requester_user_id: string | null;
  requester_login: string | null;
  requester_display_name: string | null;
  state: SongRequestState;
  operation_id: string;
  failure_reason: string | null;
  stream_id: string | null;
  created_at: string;
  updated_at: string;
}

const rowToRequest = (row: SongRequestSqlRow): SongRequestRow => {
  let artists: string[] = [];
  try {
    const value: unknown = JSON.parse(row.artists_json);
    if (Array.isArray(value)) artists = value.filter((artist): artist is string => typeof artist === "string");
  } catch { /* Invalid legacy artist JSON stays empty. */ }
  return {
    requestId: row.id,
    source: row.source,
    id: row.track_id,
    uri: row.track_uri,
    title: row.title,
    artists,
    durationMs: row.duration_ms,
    explicit: row.explicit === 1,
    coverUrl: row.cover_url,
    spotifyUrl: row.spotify_url,
    requesterUserId: row.requester_user_id,
    requesterLogin: row.requester_login,
    requesterDisplayName: row.requester_display_name,
    state: row.state,
    operationId: row.operation_id,
    failureReason: row.failure_reason,
    streamId: row.stream_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const allowedTransitions: Readonly<Record<"new" | SongRequestState, readonly SongRequestState[]>> = {
  new: ["pending_review", "approved", "rejected"],
  pending_review: ["approved", "rejected", "failed"],
  approved: ["submitting", "rejected", "failed"],
  submitting: ["submitted", "outcome_unknown", "failed"],
  submitted: ["observed_playing", "not_observed"],
  observed_playing: [],
  not_observed: [],
  outcome_unknown: ["submitted", "failed"],
  rejected: [],
  removed: [],
  failed: [],
};

interface NewSongRequest {
  source: SongRequestRow["source"];
  track: SongRequestTrack;
  operationId: string;
  streamId: string | null;
  requesterUserId?: string | null;
  requesterLogin?: string | null;
  requesterDisplayName?: string | null;
}

export interface RequestTransition {
  channelId: string;
  requestId: string;
  fromState: SongRequestState | null;
  toState: SongRequestState;
  now: string;
  failureReason?: string | null;
  streamId?: string | null;
  expectedUpdatedBefore?: string;
  onlyIfOpenBallotId?: string;
  newRequest?: NewSongRequest;
  companionStatements?: readonly D1PreparedStatement[];
}

/** The only writer of song request states and their transition timestamps. */
export const transitionRequest = async (db: D1Database, input: RequestTransition): Promise<boolean> => {
  const from = input.fromState ?? "new";
  if (!allowedTransitions[from].includes(input.toState)) return false;
  const reason = input.failureReason ?? null;
  let transition: D1PreparedStatement;
  if (input.fromState === null) {
    const request = input.newRequest;
    if (request === undefined || request.track.id.length === 0) return false;
    const ballotGuard = input.onlyIfOpenBallotId === undefined ? "" :
      " AND EXISTS (SELECT 1 FROM song_requests_votes WHERE channel_id = ? AND ballot_id = ? AND state = 'open')";
    const bindings: (string | number | null)[] = [
      input.requestId, input.channelId, request.source, request.track.id, request.track.uri,
      request.track.title, JSON.stringify(request.track.artists), request.track.durationMs,
      Number(request.track.explicit), request.track.coverUrl, request.track.spotifyUrl,
      request.requesterUserId ?? null, request.requesterLogin ?? null, request.requesterDisplayName ?? null,
      input.toState, request.operationId, reason, request.streamId, input.now, input.now,
    ];
    if (input.onlyIfOpenBallotId !== undefined) bindings.push(input.channelId, input.onlyIfOpenBallotId);
    transition = db.prepare(
      `INSERT INTO song_requests
        (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
         requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason, stream_id, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE 1 = 1${ballotGuard}
       ON CONFLICT (operation_id) DO NOTHING`,
    ).bind(...bindings);
  } else {
    const conditions: string[] = ["channel_id = ?", "id = ?", "state = ?"];
    const bindings: (string | number | null)[] = [input.toState, reason, input.now, input.toState, input.now, input.toState, input.now,
      input.channelId, input.requestId, input.fromState];
    if (input.streamId !== undefined) {
      conditions.push("stream_id IS ?");
      bindings.push(input.streamId);
    }
    if (input.expectedUpdatedBefore !== undefined) {
      conditions.push("updated_at < ?");
      bindings.push(input.expectedUpdatedBefore);
    }
    transition = db.prepare(
      `UPDATE song_requests SET state = ?, failure_reason = ?, updated_at = ?,
         submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END,
         observed_at = CASE WHEN ? = 'observed_playing' THEN ? ELSE observed_at END
        WHERE ${conditions.join(" AND ")}`,
    ).bind(...bindings);
  }
  const results = await db.batch([transition, ...(input.companionStatements ?? [])]);
  return (results[0]?.meta.changes ?? 0) === 1 && results.slice(1).every((result) => (result?.meta.changes ?? 0) === 1);
};

export const songRequestTrackFromSpotify = (track: SpotifyTrack): SongRequestTrack => {
  const compact = compactSpotifyTrack(track);
  return {
    id: compact.id,
    uri: compact.uri,
    title: compact.title,
    artists: compact.artists,
    durationMs: compact.durationMs,
    explicit: compact.explicit,
    coverUrl: compact.coverUrl,
    spotifyUrl: compact.spotifyUrl,
  };
};

export const readSongRequest = async (db: D1Database, channelId: string, requestId: string): Promise<SongRequestRow | null> => {
  const row = await db.prepare(
    `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
            requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
            stream_id, created_at, updated_at
       FROM song_requests WHERE channel_id = ? AND id = ? LIMIT 1`,
  ).bind(channelId, requestId).first<SongRequestSqlRow>();
  return row === null ? null : rowToRequest(row);
};

export const recentSongRequests = async (db: D1Database, channelId: string, streamId: string | null): Promise<SongRequestRow[]> => {
  const rows = await db.prepare(
    `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
            requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
            stream_id, created_at, updated_at
       FROM song_requests
      WHERE channel_id = ? AND stream_id IS ?
      ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(channelId, streamId).all<SongRequestSqlRow>();
  return rows.results.map(rowToRequest);
};

export interface SongVoteOutcome {
  ballotId: string;
  state: "tie" | "no_votes" | "failed";
  createdAt: string;
}

export const latestSongRequestStreamId = async (db: D1Database, channelId: string, currentStreamId: string | null): Promise<string | null> => {
  if (currentStreamId !== null) return currentStreamId;
  const row = await db.prepare(
    `SELECT stream_id FROM (
       SELECT stream_id, created_at FROM song_requests WHERE channel_id = ? AND stream_id IS NOT NULL
       UNION ALL
       SELECT stream_id, created_at FROM song_requests_votes WHERE channel_id = ? AND stream_id IS NOT NULL
     ) ORDER BY created_at DESC, stream_id DESC LIMIT 1`,
  ).bind(channelId, channelId).first<{ stream_id: string }>();
  return row?.stream_id ?? null;
};

export const recentSongVoteOutcomes = async (db: D1Database, channelId: string, streamId: string | null): Promise<SongVoteOutcome[]> => {
  const rows = await db.prepare(
    `SELECT ballot_id, state, created_at
       FROM song_requests_votes
      WHERE channel_id = ? AND stream_id IS ? AND state IN ('tie', 'no_votes', 'failed')
      ORDER BY created_at DESC, ballot_id DESC LIMIT 10`,
  ).bind(channelId, streamId).all<{ ballot_id: string; state: SongVoteOutcome["state"]; created_at: string }>();
  return rows.results.map((row) => ({ ballotId: row.ballot_id, state: row.state, createdAt: row.created_at }));
};

export const createVoteRequestClaim = async (
  db: D1Database,
  input: {
    channelId: string;
    ballotId: string;
    moderatorUserId: string;
    track: SongRequestTrack;
    streamId: string | null;
    requestId: string;
    now: string;
    initialState?: "approved" | "rejected";
    failureReason?: string | null;
  },
): Promise<boolean> => {
  const operationId = `mod_vote:${input.ballotId}`;
  const claim = db.prepare(
    `UPDATE song_requests_votes
        SET state = 'queued', request_id = ?, completed_at = ?
      WHERE channel_id = ? AND ballot_id = ? AND state = 'open'
        AND EXISTS (SELECT 1 FROM song_requests WHERE operation_id = ? AND channel_id = ?)`,
  ).bind(input.requestId, input.now, input.channelId, input.ballotId, operationId, input.channelId);
  return await transitionRequest(db, {
    channelId: input.channelId,
    requestId: input.requestId,
    fromState: null,
    toState: input.initialState ?? "approved",
    now: input.now,
    failureReason: input.failureReason,
    onlyIfOpenBallotId: input.ballotId,
    newRequest: { source: "mod_vote", track: input.track, operationId, streamId: input.streamId },
    companionStatements: [claim],
  });
};

export const voteRecord = async (db: D1Database, channelId: string, ballotId: string): Promise<{
  candidates: SongRequestTrack[];
  state: string;
  requestId: string | null;
  streamId: string | null;
} | null> => {
  const row = await db.prepare(
    "SELECT candidate_tracks_json, state, request_id, stream_id FROM song_requests_votes WHERE channel_id = ? AND ballot_id = ?",
  ).bind(channelId, ballotId).first<{ candidate_tracks_json: string; state: string; request_id: string | null; stream_id: string | null }>();
  if (row === null) return null;
  try {
    const value: unknown = JSON.parse(row.candidate_tracks_json);
    if (!Array.isArray(value)) return null;
    return { candidates: value as SongRequestTrack[], state: row.state, requestId: row.request_id, streamId: row.stream_id };
  } catch {
    return null;
  }
};

export const finishVoteWithoutRequest = async (
  db: D1Database,
  channelId: string,
  ballotId: string,
  state: "tie" | "no_votes",
  now: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE song_requests_votes SET state = ?, completed_at = ?
      WHERE channel_id = ? AND ballot_id = ? AND state = 'open'`,
  ).bind(state, now, channelId, ballotId).run();
  return (result.meta.changes ?? 0) === 1;
};

export const createNowPlayingSnapshot = async (
  db: D1Database,
  channelId: string,
  streamId: string,
  track: SpotifyTrack | null,
  now: string,
  progressMs?: number | null,
): Promise<{ changed: boolean; revision: number; state: Record<string, unknown> | null }> => {
  const current = await db.prepare(
    "SELECT revision, track_json, request_id, progress_ms FROM song_requests_now_playing WHERE channel_id = ?",
  ).bind(channelId).first<{ revision: number; track_json: string | null; request_id: string | null; progress_ms: number | null }>();
  let previousTrackId: string | null = null;
  if (current?.track_json !== null && current?.track_json !== undefined) {
    try {
      const previous: unknown = JSON.parse(current.track_json);
      if (typeof previous === "object" && previous !== null && typeof (previous as Record<string, unknown>).id === "string") {
        previousTrackId = (previous as Record<string, unknown>).id as string;
      }
    } catch { /* A damaged snapshot is treated as stale and replaced. */ }
  }
  const nextTrackId = track?.id ?? null;
  const sameTrack = current !== null && previousTrackId === nextTrackId && nextTrackId !== null;
  const progressDropped = current !== null && sameTrack && progressMs !== undefined && progressMs !== null &&
    current.progress_ms !== null && progressMs < current.progress_ms;
  const trackChanged = current === null ? track !== null : previousTrackId !== nextTrackId;
  const changed = trackChanged || progressDropped;
  const nextProgress = track === null ? null : progressMs ?? current?.progress_ms ?? null;
  if (!changed && current !== null) {
    await db.prepare("UPDATE song_requests_now_playing SET progress_ms = ? WHERE channel_id = ?")
      .bind(nextProgress, channelId).run();
    return { changed: false, revision: current.revision, state: null };
  }
  if (!changed && current === null && track === null) return { changed: false, revision: 0, state: null };

  let matched: SongRequestSqlRow | null = null;
  if (track !== null && changed) {
    matched = await db.prepare(
      `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
              requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
              stream_id, created_at, updated_at
         FROM song_requests
        WHERE channel_id = ? AND stream_id = ? AND track_id = ? AND state = 'submitted'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).bind(channelId, streamId, track.id).first<SongRequestSqlRow>();
  }
  const request = matched === null ? null : rowToRequest(matched);
  const compact = track === null ? null : compactSpotifyTrack(track);
  let priorState: Record<string, unknown> | null = null;
  if (current?.track_json !== null && current?.track_json !== undefined) {
    try {
      const parsed: unknown = JSON.parse(current.track_json);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) priorState = parsed as Record<string, unknown>;
    } catch { /* A damaged snapshot is replaced from the live Spotify response. */ }
  }
  const state: Record<string, unknown> | null = compact === null ? null : sameTrack && request === null && priorState !== null ? priorState : {
    id: compact.id,
    title: compact.title,
    artist: compact.artists.join(", "),
    coverUrl: compact.coverUrl,
    spotifyUrl: compact.spotifyUrl,
    requester: request?.source === "mod_vote" ? null : request?.requesterDisplayName ?? null,
    source: request?.source ?? "manual",
  };
  const serialized = state === null ? null : JSON.stringify(state);
  const revision = (current?.revision ?? 0) + Number(changed);
  const snapshotWrite = db.prepare(
    `INSERT INTO song_requests_now_playing (channel_id, revision, track_json, request_id, progress_ms, observed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE SET revision = excluded.revision, track_json = excluded.track_json,
       request_id = excluded.request_id, progress_ms = excluded.progress_ms, observed_at = excluded.observed_at`,
  ).bind(channelId, revision, serialized, request?.requestId ?? (sameTrack ? current?.request_id ?? null : null), nextProgress, now);
  if (request !== null) {
    await transitionRequest(db, {
      channelId,
      requestId: request.requestId,
      fromState: "submitted",
      toState: "observed_playing",
      now,
      streamId,
      companionStatements: [snapshotWrite],
    });
  } else {
    await snapshotWrite.run();
  }
  return { changed: true, revision, state };
};

export const clearSongRequestsForStreamEnd = async (
  db: D1Database,
  channelId: string,
  streamId: string | null,
  now: string,
): Promise<{ changed: boolean; revision: number }> => {
  const rows = await db.prepare(
    `SELECT id, state FROM song_requests
      WHERE channel_id = ? AND (stream_id = ? OR stream_id IS NULL)
        AND state IN ('submitted', 'pending_review', 'approved', 'submitting', 'outcome_unknown')`,
  ).bind(channelId, streamId).all<{ id: string; state: SongRequestState }>();
  let requestsChanged = false;
  for (const row of rows.results) {
    const toState: SongRequestState = row.state === "submitted" ? "not_observed"
      : row.state === "submitting" ? "outcome_unknown"
        : row.state === "outcome_unknown" ? "failed" : "rejected";
    const reason = row.state === "submitted" ? null : "stream_ended";
    requestsChanged = await transitionRequest(db, {
      channelId, requestId: row.id, fromState: row.state, toState, failureReason: reason, now,
    }) || requestsChanged;
  }
  const current = await db.prepare(
    "SELECT revision, track_json FROM song_requests_now_playing WHERE channel_id = ?",
  ).bind(channelId).first<{ revision: number; track_json: string | null }>();
  if (current?.track_json !== null && current?.track_json !== undefined) {
    await db.prepare(
      `UPDATE song_requests_now_playing SET revision = revision + 1, track_json = NULL, request_id = NULL,
        progress_ms = NULL, observed_at = ? WHERE channel_id = ?`,
    ).bind(now, channelId).run();
  }
  const hasTrack = current?.track_json !== null && current?.track_json !== undefined;
  return {
    changed: requestsChanged || hasTrack,
    revision: (current?.revision ?? 0) + Number(hasTrack),
  };
};

export const resolveUnknownRequest = async (
  db: D1Database,
  channelId: string,
  requestId: string,
  state: "submitted" | "failed",
  now: string,
): Promise<boolean> => {
  return await transitionRequest(db, {
    channelId, requestId, fromState: "outcome_unknown", toState: state, failureReason: null, now,
  });
};

export const nowPlayingSnapshot = async (db: D1Database, channelId: string): Promise<Record<string, unknown> | null> => {
  const row = await db.prepare("SELECT track_json FROM song_requests_now_playing WHERE channel_id = ?")
    .bind(channelId).first<{ track_json: string | null }>();
  if (row?.track_json == null) return null;
  try {
    const state: unknown = JSON.parse(row.track_json);
    return typeof state === "object" && state !== null && !Array.isArray(state) ? state as Record<string, unknown> : null;
  } catch { return null; }
};
