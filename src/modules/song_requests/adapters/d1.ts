import type { SpotifyTrack } from "../domain/track";
import { compactSpotifyTrack } from "../domain/track";
import type { SongRequestsSettings } from "../contracts";

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

export type SongRequestState = "charging" | "pending_review" | "approved" | "submitting" | "submitted" | "observed_playing" |
  "not_observed" | "outcome_unknown" | "rejected" | "removed" | "failed";
type SongRequestType = "vote" | "bot_points" | "free" | "channel_points";

export interface SongRequestRow extends SongRequestTrack {
  requestId: string;
  source: "mod_vote" | "channel_points" | "points";
  requestType: SongRequestType;
  requesterUserId: string | null;
  requesterLogin: string | null;
  requesterDisplayName: string | null;
  state: SongRequestState;
  operationId: string;
  failureReason: string | null;
  streamId: string | null;
  roundId: string | null;
  chargedAmount: number;
  createdAt: string;
  updatedAt: string;
}

interface SongRequestSqlRow {
  id: string;
  source: SongRequestRow["source"];
  request_type: SongRequestType;
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
  round_id: string | null;
  charged_amount: number;
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
    requestType: row.request_type,
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
    roundId: row.round_id,
    chargedAmount: row.charged_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const allowedTransitions: Readonly<Record<"new" | SongRequestState, readonly SongRequestState[]>> = {
  new: ["charging", "pending_review", "approved", "rejected"],
  charging: ["pending_review", "approved", "failed"],
  pending_review: ["approved", "rejected", "failed"],
  approved: ["submitting", "rejected", "failed"],
  submitting: ["submitted", "outcome_unknown", "failed", "rejected"],
  submitted: ["observed_playing", "not_observed", "removed"],
  observed_playing: [],
  not_observed: [],
  outcome_unknown: ["submitted", "failed", "removed"],
  rejected: [],
  removed: [],
  failed: [],
};

interface NewSongRequest {
  source: SongRequestRow["source"];
  requestType?: SongRequestType;
  track: SongRequestTrack;
  operationId: string;
  streamId: string | null;
  roundId?: string | null;
  chargedAmount?: number;
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
  refundDue?: boolean;
  streamId?: string | null;
  activeStreamId?: string;
  activeRoundId?: string;
  chargedAmount?: number;
  chargedAt?: string;
  expectedUpdatedBefore?: string;
  expectedChargingBefore?: string;
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
    const activeRoundGuard = input.activeRoundId === undefined ? "" : `
       AND ? = ?
       AND ((? IS NOT NULL AND EXISTS (
         SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?
       )) OR (? IS NULL AND EXISTS (
         SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline'
       ) AND EXISTS (
         SELECT 1 FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ?
       ) AND EXISTS (
         SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
           AND json_extract(settings, '$.alsoOffline') = 1
       )))`;
    const bindings: (string | number | null)[] = [
      input.requestId, input.channelId, request.source, request.track.id, request.track.uri,
      request.track.title, JSON.stringify(request.track.artists), request.track.durationMs,
      Number(request.track.explicit), request.track.coverUrl, request.track.spotifyUrl,
      request.requesterUserId ?? null, request.requesterLogin ?? null, request.requesterDisplayName ?? null,
      input.toState, request.operationId, reason, request.streamId, request.roundId ?? request.streamId,
      request.requestType ?? (request.source === "mod_vote" ? "vote" : "bot_points"), request.chargedAmount ?? 0, input.now, input.now,
    ];
    if (input.onlyIfOpenBallotId !== undefined) bindings.push(input.channelId, input.onlyIfOpenBallotId);
    if (input.activeRoundId !== undefined) bindings.push(
      request.roundId ?? request.streamId, input.activeRoundId,
      request.streamId, input.channelId, request.streamId,
      request.streamId, input.channelId, input.channelId, input.activeRoundId, input.channelId,
    );
    transition = db.prepare(
      `INSERT INTO song_requests
        (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
         requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason, stream_id, round_id,
         request_type, charged_amount, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE 1 = 1${ballotGuard}${activeRoundGuard}
       ON CONFLICT (operation_id) DO NOTHING
       RETURNING id`,
    ).bind(...bindings);
  } else {
    const conditions: string[] = ["channel_id = ?", "id = ?", "state = ?"];
    const bindings: (string | number | null)[] = [input.toState, reason, input.now, input.toState, input.now, input.toState, input.now,
      input.chargedAmount ?? null, input.chargedAt ?? null,
      input.channelId, input.requestId, input.fromState];
    if (input.streamId !== undefined) {
      conditions.push("stream_id IS ?");
      bindings.push(input.streamId);
    }
    if (input.expectedUpdatedBefore !== undefined) {
      conditions.push("updated_at < ?");
      bindings.push(input.expectedUpdatedBefore);
    }
    if (input.expectedChargingBefore !== undefined) {
      conditions.push("charging_since < ?");
      bindings.push(input.expectedChargingBefore);
    }
    if (input.activeRoundId !== undefined) {
      conditions.push("round_id = ?");
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM channel_stream_state
           WHERE channel_id = ? AND state = 'online' AND stream_id = ? AND song_requests.stream_id = ?
        ) OR (
          song_requests.stream_id IS NULL
          AND EXISTS (
            SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline'
          )
          AND EXISTS (
            SELECT 1 FROM song_requests_offline_rounds
             WHERE channel_id = ? AND round_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM channel_modules
             WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
               AND json_extract(settings, '$.alsoOffline') = 1
          )
        )
      )`);
      bindings.push(input.activeRoundId, input.channelId, input.activeRoundId, input.activeRoundId,
        input.channelId, input.channelId, input.activeRoundId, input.channelId);
      conditions.push("EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1)");
      conditions.push("EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)");
      bindings.push(input.channelId, input.channelId);
    } else if (input.activeStreamId !== undefined) {
      conditions.push(`EXISTS (
        SELECT 1 FROM channel_stream_state
         WHERE channel_id = ? AND state = 'online' AND stream_id = ?
      )`);
      conditions.push(`EXISTS (
        SELECT 1 FROM channel_modules
         WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
      )`);
      conditions.push("EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)");
      bindings.push(input.channelId, input.activeStreamId, input.channelId, input.channelId);
    }
    transition = db.prepare(
      `UPDATE song_requests SET state = ?, failure_reason = ?, updated_at = ?,
         submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE submitted_at END,
         observed_at = CASE WHEN ? = 'observed_playing' THEN ? ELSE observed_at END,
         charged_amount = COALESCE(?, charged_amount),
         charged_at = COALESCE(?, charged_at),
         refund_due = CASE WHEN ? = 1 AND request_type = 'bot_points' THEN 1
           WHEN ? = 0 THEN 0 ELSE refund_due END
        WHERE ${conditions.join(" AND ")}
       RETURNING id`,
    ).bind(...bindings.slice(0, 9), input.refundDue === true ? 1 : input.refundDue === false ? 0 : null,
      input.refundDue === true ? 1 : input.refundDue === false ? 0 : null, ...bindings.slice(9));
  }
  const results = await db.batch([transition, ...(input.companionStatements ?? [])]);
  // RETURNING sees the matched request row directly, excluding panel revision trigger writes.
  return (results[0]?.results.length ?? 0) > 0 && results.slice(1).every((result) => result.meta.changes > 0);
};

export interface SongRequestAdmissionInput {
  channelId: string;
  requestId: string;
  operationId: string;
  track: SongRequestTrack;
  requestType: "bot_points" | "free";
  streamId: string | null;
  roundId: string;
  settingsJson: string;
  settings: SongRequestsSettings;
  requesterUserId: string;
  requesterLogin: string;
  requesterDisplayName: string;
  initialState: "pending_review" | "approved";
  now: string;
}

const OPEN_REQUEST_SQL = "state IN ('charging', 'pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')";
const OPEN_OR_PLAYING_REQUEST_SQL = `(${OPEN_REQUEST_SQL} OR (state = 'removed' AND submitted_at IS NOT NULL))`;

/** Inserts only when all configured limits and the current stream/offline round still match. */
export const admitSongRequest = async (
  db: D1Database,
  input: SongRequestAdmissionInput,
): Promise<{ accepted: boolean; position: number | null }> => {
  const { rules } = input.settings;
  const songCooldownAt = new Date(Date.parse(input.now) - rules.songCooldownMinutes * 60_000).toISOString();
  const personCooldownAt = new Date(Date.parse(input.now) - rules.personCooldownMinutes * 60_000).toISOString();
  const artistsJson = JSON.stringify(input.track.artists);
  const blockedTrackIdsJson = JSON.stringify(rules.blockedTrackIds);
  const blockedArtistsJson = JSON.stringify(rules.blockedArtists);
  const admitted = await db.prepare(
    `INSERT INTO song_requests
      (id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
       requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason, stream_id,
       round_id, request_type, charged_amount, created_at, updated_at)
     SELECT ?, ?, 'points', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM channel_modules
         WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1 AND settings = ?
      )
        AND EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
        AND (? != 'bot_points' OR EXISTS (
          SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'points' AND enabled = 1
        ))
        AND (
          (? IS NOT NULL AND EXISTS (
            SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?
          ) AND ? = ?)
          OR
          (? IS NULL AND EXISTS (
            SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline'
          ) AND EXISTS (
            SELECT 1 FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ?
          ) AND EXISTS (
            SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
              AND settings = ? AND json_extract(settings, '$.alsoOffline') = 1
          ))
        )
        AND (? = 0 OR ? = 0)
        AND (? = 0 OR ? <= ?)
        AND (? = 0 OR ? NOT IN (SELECT value FROM json_each(?)))
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM json_each(?) AS requested_artist
          JOIN json_each(?) AS blocked_artist
            ON lower(CAST(requested_artist.value AS TEXT)) = lower(CAST(blocked_artist.value AS TEXT))
        ))
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.round_id = ? AND prior.track_id = ?
             AND ${OPEN_OR_PLAYING_REQUEST_SQL}
        ))
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.track_id = ?
             AND (? = 0 OR prior.round_id = ?)
             AND prior.submitted_at IS NOT NULL
             AND (? = 1 OR prior.submitted_at >= ?)
        ))
        AND (? = 0 OR (
          SELECT COUNT(*) FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.round_id = ? AND prior.requester_user_id = ?
             AND (${OPEN_REQUEST_SQL}
               OR (prior.request_type = 'free' AND prior.state != 'failed')
               OR (prior.charged_at IS NOT NULL AND prior.state != 'failed'))
             AND (prior.state != 'rejected' OR prior.request_type = 'free' OR prior.charged_at IS NOT NULL)
             AND prior.created_at >= ?
        ) = 0)
        AND (? = 0 OR (
          SELECT COUNT(*) FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.round_id = ? AND prior.requester_user_id = ?
             AND ${OPEN_REQUEST_SQL}
        ) < ?)
        AND (? = 0 OR (
          SELECT COUNT(*) FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.round_id = ? AND prior.requester_user_id = ?
             AND prior.state NOT IN ('rejected', 'failed')
        ) < ?)
        AND (? = 0 OR (
          SELECT COUNT(*) FROM song_requests AS prior
           WHERE prior.channel_id = ? AND prior.round_id = ? AND ${OPEN_REQUEST_SQL}
        ) < ?)
        AND (? = 0 OR NOT EXISTS (
          SELECT 1
            FROM song_requests AS prior
            JOIN json_each(prior.artists_json) AS prior_artist
            JOIN json_each(?) AS requested_artist
              ON lower(CAST(prior_artist.value AS TEXT)) = lower(CAST(requested_artist.value AS TEXT))
           WHERE prior.channel_id = ? AND prior.round_id = ? AND ${OPEN_OR_PLAYING_REQUEST_SQL}
           GROUP BY lower(CAST(requested_artist.value AS TEXT))
          HAVING COUNT(*) >= ?
        ))
     ON CONFLICT (operation_id) DO NOTHING
     RETURNING id`,
  ).bind(
    input.requestId, input.channelId, input.track.id, input.track.uri, input.track.title, artistsJson,
    input.track.durationMs, Number(input.track.explicit), input.track.coverUrl, input.track.spotifyUrl,
    input.requesterUserId, input.requesterLogin, input.requesterDisplayName,
    input.requestType === "bot_points" ? "charging" : input.initialState, input.operationId,
    input.streamId, input.roundId, input.requestType,
    input.requestType === "bot_points" ? input.settings.botPointsCost : 0, input.now, input.now,
    input.channelId, input.settingsJson, input.channelId, input.requestType, input.channelId,
    input.streamId, input.channelId, input.streamId, input.roundId, input.roundId,
    input.streamId, input.channelId, input.channelId, input.roundId, input.channelId, input.settingsJson,
    Number(!rules.explicitAllowed), Number(input.track.explicit), Number(rules.maxTrackLengthEnabled),
    input.track.durationMs, rules.maxTrackLengthMinutes * 60_000,
    Number(rules.blockTracksEnabled), input.track.id, blockedTrackIdsJson, Number(rules.blockArtistsEnabled), artistsJson, blockedArtistsJson,
    Number(rules.duplicateEnabled), input.channelId, input.roundId, input.track.id,
    Number(rules.songCooldownEnabled), input.channelId, input.track.id, Number(rules.songCooldownOncePerRound),
    input.roundId, Number(rules.songCooldownOncePerRound), songCooldownAt,
    Number(rules.personCooldownEnabled && rules.personCooldownMinutes > 0), input.channelId, input.roundId,
    input.requesterUserId, personCooldownAt,
    Number(rules.personOpenLimitEnabled), input.channelId, input.roundId, input.requesterUserId, rules.personOpenLimit,
    Number(rules.personRoundLimitEnabled), input.channelId, input.roundId, input.requesterUserId, rules.personRoundLimit,
    Number(rules.channelOpenLimitEnabled), input.channelId, input.roundId, rules.channelOpenLimit,
    Number(rules.artistOpenLimitEnabled), artistsJson, input.channelId, input.roundId, rules.artistOpenLimit,
  ).first<{ id: string }>();
  if (admitted === null) return { accepted: false, position: null };
  const row = await db.prepare(
    `SELECT COUNT(*) AS position FROM song_requests
      WHERE channel_id = ? AND round_id = ? AND ${OPEN_REQUEST_SQL}
        AND (created_at < ? OR (created_at = ? AND id <= ?))`,
  ).bind(input.channelId, input.roundId, input.now, input.now, input.requestId).first<{ position: number }>();
  return { accepted: true, position: row?.position ?? 1 };
};

export const songRequestAdmissionFailure = async (
  db: D1Database,
  input: SongRequestAdmissionInput,
): Promise<{ code: string; position?: number }> => {
  const { rules } = input.settings;
  const count = async (sql: string, values: readonly (string | number | null)[]): Promise<number> =>
    (await db.prepare(sql).bind(...values).first<{ count: number }>())?.count ?? 0;
  if (!rules.explicitAllowed && input.track.explicit) return { code: "explicit_not_allowed" };
  if (rules.maxTrackLengthEnabled && input.track.durationMs > rules.maxTrackLengthMinutes * 60_000) return { code: "track_too_long" };
  if (rules.blockTracksEnabled && rules.blockedTrackIds.includes(input.track.id)) return { code: "track_blocked" };
  if (rules.blockArtistsEnabled && input.track.artists.some((artist) => rules.blockedArtists.some((blocked) => blocked.localeCompare(artist, undefined, { sensitivity: "accent" }) === 0))) {
    return { code: "artist_blocked" };
  }
  if (rules.duplicateEnabled) {
    const duplicate = await db.prepare(
      `SELECT id, created_at FROM song_requests WHERE channel_id = ? AND round_id = ? AND track_id = ?
        AND ${OPEN_OR_PLAYING_REQUEST_SQL} ORDER BY created_at, id LIMIT 1`,
    ).bind(input.channelId, input.roundId, input.track.id).first<{ id: string; created_at: string }>();
    if (duplicate !== null) {
      const row = await db.prepare(
        `SELECT COUNT(*) AS position FROM song_requests WHERE channel_id = ? AND round_id = ? AND ${OPEN_REQUEST_SQL}
          AND (created_at < ? OR (created_at = ? AND id <= ?))`,
      ).bind(input.channelId, input.roundId, duplicate.created_at, duplicate.created_at, duplicate.id).first<{ position: number }>();
      return { code: "already_requested", position: row?.position ?? 1 };
    }
  }
  if (rules.songCooldownEnabled) {
    const cutoff = rules.songCooldownOncePerRound
      ? null
      : new Date(Date.parse(input.now) - rules.songCooldownMinutes * 60_000).toISOString();
    const roundFilter = rules.songCooldownOncePerRound ? " AND round_id = ?" : "";
    const cooldownBindings: (string | number | null)[] = rules.songCooldownOncePerRound
      ? [input.channelId, input.roundId, input.track.id]
      : [input.channelId, input.track.id];
    if (cutoff !== null) cooldownBindings.push(cutoff);
    const recent = await count(
      `SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ?${roundFilter} AND track_id = ? AND submitted_at IS NOT NULL${cutoff === null ? "" : " AND submitted_at >= ?"}`,
      cooldownBindings,
    );
    if (recent > 0) return { code: "song_cooldown" };
  }
  if (rules.personCooldownEnabled && rules.personCooldownMinutes > 0 && await count(
    `SELECT COUNT(*) AS count FROM song_requests AS prior WHERE prior.channel_id = ? AND prior.round_id = ? AND prior.requester_user_id = ?
       AND (${OPEN_REQUEST_SQL} OR (prior.request_type = 'free' AND prior.state != 'failed')
         OR (prior.charged_at IS NOT NULL AND prior.state != 'failed'))
       AND (prior.state != 'rejected' OR prior.request_type = 'free' OR prior.charged_at IS NOT NULL)
       AND prior.created_at >= ?`,
    [input.channelId, input.roundId, input.requesterUserId, new Date(Date.parse(input.now) - rules.personCooldownMinutes * 60_000).toISOString()],
  ) > 0) return { code: "person_cooldown" };
  if (rules.personOpenLimitEnabled && await count(
    `SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND round_id = ? AND requester_user_id = ? AND ${OPEN_REQUEST_SQL}`,
    [input.channelId, input.roundId, input.requesterUserId],
  ) >= rules.personOpenLimit) return { code: "person_open_limit" };
  if (rules.personRoundLimitEnabled && await count(
    `SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND round_id = ? AND requester_user_id = ? AND state NOT IN ('rejected', 'failed')`,
    [input.channelId, input.roundId, input.requesterUserId],
  ) >= rules.personRoundLimit) return { code: "person_round_limit" };
  if (rules.channelOpenLimitEnabled && await count(
    `SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND round_id = ? AND ${OPEN_REQUEST_SQL}`,
    [input.channelId, input.roundId],
  ) >= rules.channelOpenLimit) return { code: "channel_open_limit" };
  if (rules.artistOpenLimitEnabled) {
    for (const artist of input.track.artists) {
      if (await count(
        `SELECT COUNT(*) AS count FROM song_requests AS prior JOIN json_each(prior.artists_json) AS prior_artist
          WHERE prior.channel_id = ? AND prior.round_id = ? AND lower(CAST(prior_artist.value AS TEXT)) = lower(?) AND ${OPEN_OR_PLAYING_REQUEST_SQL}`,
        [input.channelId, input.roundId, artist],
      ) >= rules.artistOpenLimit) return { code: "artist_open_limit" };
    }
  }
  return { code: "request_unavailable" };
};

export const ensureOfflineSongRequestRound = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<string | null> => {
  const candidate = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO song_requests_offline_rounds (channel_id, round_id, created_at)
     SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline')
        AND EXISTS (
          SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
            AND json_extract(settings, '$.alsoOffline') = 1
        )
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, candidate, now, channelId, channelId).run();
  return (await db.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
    .bind(channelId).first<{ round_id: string }>())?.round_id ?? null;
};

export const readOfflineSongRequestRound = async (db: D1Database, channelId: string): Promise<string | null> =>
  (await db.prepare("SELECT round_id FROM song_requests_offline_rounds WHERE channel_id = ?")
    .bind(channelId).first<{ round_id: string }>())?.round_id ?? null;

export const closeOfflineSongRequestRound = async (
  db: D1Database,
  channelId: string,
  expectedRoundId?: string,
): Promise<string | null> => {
  const statement = expectedRoundId === undefined
    ? db.prepare("DELETE FROM song_requests_offline_rounds WHERE channel_id = ? RETURNING round_id").bind(channelId)
    : db.prepare("DELETE FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ? RETURNING round_id")
      .bind(channelId, expectedRoundId);
  return (await statement.first<{ round_id: string }>())?.round_id ?? null;
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

export const spotifySlotHeld = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare("SELECT 1 AS enabled FROM spotify_channel_access WHERE channel_id = ?")
    .bind(channelId).first()) !== null;

export const readSongRequest = async (db: D1Database, channelId: string, requestId: string): Promise<SongRequestRow | null> => {
  const row = await db.prepare(
    `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
            requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
            stream_id, round_id, request_type, charged_amount, created_at, updated_at
       FROM song_requests WHERE channel_id = ? AND id = ? LIMIT 1`,
  ).bind(channelId, requestId).first<SongRequestSqlRow>();
  return row === null ? null : rowToRequest(row);
};

export const songRequestRefundIsDue = async (db: D1Database, channelId: string, requestId: string): Promise<boolean> =>
  (await db.prepare("SELECT refund_due FROM song_requests WHERE channel_id = ? AND id = ?")
    .bind(channelId, requestId).first<{ refund_due: number }>())?.refund_due === 1;

export const markSongRequestRefundComplete = async (db: D1Database, channelId: string, requestId: string): Promise<void> => {
  await db.prepare("UPDATE song_requests SET refund_due = 0 WHERE channel_id = ? AND id = ? AND refund_due = 1 AND state != 'charging'")
    .bind(channelId, requestId).run();
};

export const markSongRequestRefundDue = async (db: D1Database, channelId: string, requestId: string): Promise<void> => {
  await db.prepare(
    `UPDATE song_requests SET refund_due = 1
      WHERE channel_id = ? AND id = ? AND request_type = 'bot_points' AND refund_due = 0
        AND state IN ('observed_playing', 'not_observed', 'rejected', 'removed', 'failed')`,
  ).bind(channelId, requestId).run();
};

export const songRequestRefundDueIds = async (
  db: D1Database,
  channelId: string,
  roundId?: string,
): Promise<string[]> => {
  const roundFilter = roundId === undefined ? "" : " AND round_id = ?";
  const statement = db.prepare(
    `SELECT id FROM song_requests WHERE channel_id = ? AND refund_due = 1
       AND state IN ('observed_playing', 'not_observed', 'rejected', 'removed', 'failed')${roundFilter}
      ORDER BY created_at, id`,
  );
  const rows = await (roundId === undefined ? statement.bind(channelId) : statement.bind(channelId, roundId))
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
};

export const recentSongRequests = async (db: D1Database, channelId: string, roundId: string | null): Promise<SongRequestRow[]> => {
  const rows = await db.prepare(
    `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
            requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
            stream_id, round_id, request_type, charged_amount, created_at, updated_at
       FROM song_requests
      WHERE channel_id = ? AND round_id IS ? AND state != 'charging'
      ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(channelId, roundId).all<SongRequestSqlRow>();
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
    `SELECT round_id FROM (
       SELECT COALESCE(round_id, stream_id) AS round_id, created_at FROM song_requests WHERE channel_id = ? AND COALESCE(round_id, stream_id) IS NOT NULL
       UNION ALL
       SELECT COALESCE(round_id, stream_id) AS round_id, created_at FROM song_requests_votes WHERE channel_id = ? AND COALESCE(round_id, stream_id) IS NOT NULL
     ) ORDER BY created_at DESC, round_id DESC LIMIT 1`,
  ).bind(channelId, channelId).first<{ round_id: string }>();
  return row?.round_id ?? null;
};

export const recentSongVoteOutcomes = async (db: D1Database, channelId: string, roundId: string | null): Promise<SongVoteOutcome[]> => {
  const rows = await db.prepare(
    `SELECT ballot_id, state, created_at
       FROM song_requests_votes
      WHERE channel_id = ? AND COALESCE(round_id, stream_id) IS ? AND state IN ('tie', 'no_votes', 'failed')
      ORDER BY created_at DESC, ballot_id DESC LIMIT 10`,
  ).bind(channelId, roundId).all<{ ballot_id: string; state: SongVoteOutcome["state"]; created_at: string }>();
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
    roundId?: string | null;
    requestId: string;
    now: string;
    activeRoundId?: string;
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
    failureReason: input.failureReason ?? null,
    ...(input.activeRoundId === undefined ? {} : { activeRoundId: input.activeRoundId }),
    onlyIfOpenBallotId: input.ballotId,
    newRequest: { source: "mod_vote", requestType: "vote", track: input.track, operationId, streamId: input.streamId, roundId: input.roundId ?? input.streamId },
    companionStatements: [claim],
  });
};

export const voteRecord = async (db: D1Database, channelId: string, ballotId: string): Promise<{
  candidates: SongRequestTrack[];
  state: string;
  requestId: string | null;
  streamId: string | null;
  roundId: string | null;
} | null> => {
  const row = await db.prepare(
    "SELECT candidate_tracks_json, state, request_id, stream_id, round_id FROM song_requests_votes WHERE channel_id = ? AND ballot_id = ?",
  ).bind(channelId, ballotId).first<{ candidate_tracks_json: string; state: string; request_id: string | null; stream_id: string | null; round_id: string | null }>();
  if (row === null) return null;
  try {
    const value: unknown = JSON.parse(row.candidate_tracks_json);
    if (!Array.isArray(value)) return null;
    return { candidates: value as SongRequestTrack[], state: row.state, requestId: row.request_id, streamId: row.stream_id, roundId: row.round_id };
  } catch {
    return null;
  }
};

export const finishVoteWithoutRequest = async (
  db: D1Database,
  channelId: string,
  ballotId: string,
  state: "tie" | "no_votes" | "failed",
  now: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE song_requests_votes SET state = ?, completed_at = ?
      WHERE channel_id = ? AND ballot_id = ? AND state = 'open'`,
  ).bind(state, now, channelId, ballotId).run();
  return result.meta.changes > 0;
};

export const createNowPlayingSnapshot = async (
  db: D1Database,
  channelId: string,
  roundId: string,
  track: SpotifyTrack | null,
  now: string,
  progressMs?: number | null,
  fence?: { activeStreamId: string } | { offlineRoundId: string },
): Promise<{ changed: boolean; revision: number; state: Record<string, unknown> | null; committed: boolean }> => {
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
  const roundFenceSql = fence === undefined ? "" : " AND " + ("activeStreamId" in fence
    ? `EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?)`
    : `EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline')
       AND EXISTS (SELECT 1 FROM song_requests_offline_rounds WHERE channel_id = ? AND round_id = ?)
       AND EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1
         AND json_extract(settings, '$.alsoOffline') = 1)`);
  const roundFenceBindings: (string | number | null)[] = fence === undefined ? [] : "activeStreamId" in fence
    ? [channelId, fence.activeStreamId]
    : [channelId, channelId, fence.offlineRoundId, channelId];
  if (!changed && current !== null) {
    const progressUpdate = fence === undefined
      ? db.prepare("UPDATE song_requests_now_playing SET progress_ms = ? WHERE channel_id = ?")
        .bind(nextProgress, channelId)
      : db.prepare(
        `UPDATE song_requests_now_playing SET progress_ms = ? WHERE channel_id = ?
          ${roundFenceSql}
          AND EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1)
          AND EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)`,
      ).bind(nextProgress, channelId, ...roundFenceBindings, channelId, channelId);
    const result = await progressUpdate.run();
    return { changed: false, revision: current.revision, state: null, committed: fence === undefined || result.meta.changes > 0 };
  }
  if (!changed && current === null && track === null) return { changed: false, revision: 0, state: null, committed: true };

  let matched: SongRequestSqlRow | null = null;
  if (track !== null && changed) {
    matched = await db.prepare(
      `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
              requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
              stream_id, round_id, request_type, charged_amount, created_at, updated_at
         FROM song_requests
        WHERE channel_id = ? AND round_id = ? AND track_id = ? AND state = 'submitted'
        ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).bind(channelId, roundId, track.id).first<SongRequestSqlRow>();
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
  const snapshotWrite = fence === undefined
    ? db.prepare(
      `INSERT INTO song_requests_now_playing (channel_id, revision, track_json, request_id, progress_ms, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET revision = excluded.revision, track_json = excluded.track_json,
         request_id = excluded.request_id, progress_ms = excluded.progress_ms, observed_at = excluded.observed_at`,
    ).bind(channelId, revision, serialized, request?.requestId ?? (sameTrack ? current.request_id ?? null : null), nextProgress, now)
    : db.prepare(
      `INSERT INTO song_requests_now_playing (channel_id, revision, track_json, request_id, progress_ms, observed_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE 1 = 1 ${roundFenceSql}
          AND EXISTS (SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'song_requests' AND enabled = 1)
          AND EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
       ON CONFLICT (channel_id) DO UPDATE SET revision = excluded.revision, track_json = excluded.track_json,
         request_id = excluded.request_id, progress_ms = excluded.progress_ms, observed_at = excluded.observed_at`,
    ).bind(channelId, revision, serialized, request?.requestId ?? (sameTrack ? current.request_id ?? null : null), nextProgress, now,
      ...roundFenceBindings, channelId, channelId);
  if (request !== null) {
    const committed = await transitionRequest(db, {
      channelId,
      requestId: request.requestId,
      fromState: "submitted",
      toState: "observed_playing",
      now,
      streamId: request.streamId,
      ...(fence === undefined ? {} : { activeRoundId: roundId }),
      companionStatements: [snapshotWrite],
    });
    return { changed: committed, revision, state: committed ? state : null, committed };
  }
  const result = await snapshotWrite.run();
  const committed = result.meta.changes > 0;
  return { changed: committed, revision, state: committed ? state : null, committed };
};

export const clearSongRequestsForStreamEnd = async (
  db: D1Database,
  channelId: string,
  streamId: string | null,
  now: string,
): Promise<{ changed: boolean; revision: number; refundableRequestIds: string[] }> => {
  const rows = await db.prepare(
    `SELECT id, state FROM song_requests
      WHERE channel_id = ? AND (round_id = ? OR (round_id IS NULL AND (stream_id = ? OR stream_id IS NULL)))
        AND state IN ('submitted', 'pending_review', 'approved', 'submitting', 'outcome_unknown')`,
  ).bind(channelId, streamId, streamId).all<{ id: string; state: SongRequestState }>();
  let requestsChanged = false;
  const refundableRequestIds: string[] = [];
  for (const row of rows.results) {
    const toState: SongRequestState = row.state === "submitted" ? "not_observed"
      : row.state === "submitting" || row.state === "outcome_unknown" ? "failed" : "rejected";
    const reason = row.state === "submitted" ? null
      : row.state === "submitting" || row.state === "outcome_unknown" ? "submit_outcome_uncertain" : "stream_ended";
    const changed = await transitionRequest(db, {
      channelId, requestId: row.id, fromState: row.state, toState, failureReason: reason,
      refundDue: row.state !== "submitted", now,
    });
    requestsChanged = changed || requestsChanged;
    if (changed && row.state !== "submitted") refundableRequestIds.push(row.id);
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
    refundableRequestIds,
  };
};

export const cleanupSongRequestRound = async (
  db: D1Database,
  channelId: string,
  roundId: string,
  now: string,
  reason: "stream_ended" | "offline_round_ended" | "list_cleared" | "module_disabled",
): Promise<{ changed: boolean; revision: number; refundableRequestIds: string[] }> => {
  const rows = await db.prepare(
    `SELECT id, state FROM song_requests
      WHERE channel_id = ? AND round_id = ?
        AND state IN ('pending_review', 'approved', 'submitting', 'submitted', 'outcome_unknown')
      ORDER BY created_at, id`,
  ).bind(channelId, roundId).all<{ id: string; state: SongRequestState }>();
  let requestsChanged = false;
  const refundableRequestIds: string[] = [];
  for (const row of rows.results) {
    const toState: SongRequestState = row.state === "submitted"
      ? reason === "module_disabled" || reason === "list_cleared" ? "removed" : "not_observed"
      : row.state === "submitting" || row.state === "outcome_unknown" ? "failed" : "rejected";
    const changed = await transitionRequest(db, {
      channelId,
      requestId: row.id,
      fromState: row.state,
      toState,
      failureReason: row.state === "submitting" || row.state === "outcome_unknown" ? "submit_outcome_uncertain" : reason,
      refundDue: reason === "module_disabled" || row.state !== "submitted",
      now,
    });
    requestsChanged = changed || requestsChanged;
    if (changed && (reason === "module_disabled" || row.state !== "submitted")) refundableRequestIds.push(row.id);
  }
  const current = await db.prepare(
    "SELECT revision, track_json FROM song_requests_now_playing WHERE channel_id = ?",
  ).bind(channelId).first<{ revision: number; track_json: string | null }>();
  const hasTrack = current?.track_json !== null && current?.track_json !== undefined;
  if (hasTrack) {
    await db.prepare(
      `UPDATE song_requests_now_playing SET revision = revision + 1, track_json = NULL, request_id = NULL,
        progress_ms = NULL, observed_at = ? WHERE channel_id = ?`,
    ).bind(now, channelId).run();
  }
  return {
    changed: requestsChanged || hasTrack,
    revision: (current?.revision ?? 0) + Number(hasTrack),
    refundableRequestIds,
  };
};

export const pendingSongRequestQueue = async (
  db: D1Database,
  channelId: string,
  roundId?: string | null,
): Promise<{ count: number; requests: SongRequestRow[] }> => {
  const rows = await db.prepare(
    `SELECT id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
            requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason,
            stream_id, round_id, request_type, charged_amount, created_at, updated_at
       FROM song_requests WHERE channel_id = ? AND state = 'pending_review' AND (? IS NULL OR round_id = ?)
      ORDER BY created_at, id LIMIT 100`,
  ).bind(channelId, roundId ?? null, roundId ?? null).all<SongRequestSqlRow>();
  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM song_requests WHERE channel_id = ? AND state = 'pending_review' AND (? IS NULL OR round_id = ?)",
  ).bind(channelId, roundId ?? null, roundId ?? null).first<{ count: number }>();
  return { count: count?.count ?? rows.results.length, requests: rows.results.map(rowToRequest) };
};

export const resolveUnknownRequest = async (
  db: D1Database,
  channelId: string,
  requestId: string,
  state: "submitted" | "failed",
  now: string,
): Promise<boolean> => {
  return await transitionRequest(db, {
    channelId, requestId, fromState: "outcome_unknown", toState: state, failureReason: null,
    refundDue: state === "failed",
    now,
  });
};
