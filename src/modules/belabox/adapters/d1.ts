import type { ModuleMutationAuthorization } from "../../contract";
import {
  BELABOX_MODULE_ID,
  BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  BELABOX_STATS_URL_SECRET,
  type BelaboxFetchFailureReason,
  type BelaboxPhase,
  type BelaboxStatusErrorCode,
  type BelaboxSample,
} from "../contracts";
import {
  createInitialAlertState,
  type BelaboxAlertIdempotencyKind,
  type BelaboxAlertMessageKind,
  type BelaboxAlertState,
} from "../domain/alert";

export interface BelaboxRecentPoint {
  at: string;
  bitrateKbps: number;
  rttMs: number;
  connected: boolean;
}

export interface BelaboxFetchPhase {
  consecutiveFailures: number;
  failing: boolean;
}

export interface BelaboxStatus {
  sample: BelaboxSample | null;
  errorCode: BelaboxStatusErrorCode | null;
  polling: boolean;
  streamId: string | null;
  streamSessionKey: string | null;
  belaboxStreamId: string | null;
  fetchPhase: BelaboxFetchPhase;
  alertState: BelaboxAlertState;
  recent: readonly BelaboxRecentPoint[];
  revision: number;
}

export interface BelaboxStreamSession {
  state: "online" | "offline";
  changedAt: string;
  startedAt: string | null;
  streamId: string | null;
}

interface BelaboxStatusRow {
  sampled_at: string | null;
  sample_json: string | null;
  error_code: string | null;
  polling: number;
  stream_id: string | null;
  stream_session_key: string | null;
  belabox_stream_id: string | null;
  fetch_phase_json: string;
  recent_json: string;
  alert_json: string;
  revision: number;
}

interface BelaboxStreamSessionRow {
  state: "online" | "offline";
  changed_at: string;
  started_at: string | null;
  stream_id: string | null;
}

const EMPTY_FETCH_PHASE: BelaboxFetchPhase = { consecutiveFailures: 0, failing: false };

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isBelaboxPhase = (value: unknown): value is BelaboxPhase =>
  value === "healthy" || value === "low" || value === "disconnected" || value === "inactive";

const parseSample = (value: string | null): BelaboxSample | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const sample = parsed as Readonly<Record<string, unknown>>;
    if (typeof sample.at !== "string" || typeof sample.connected !== "boolean" ||
        !finiteNonnegative(sample.bitrateKbps) || !finiteNonnegative(sample.rttMs) ||
        !finiteNonnegative(sample.latencyMs) || !finiteNonnegative(sample.network) ||
        !finiteNonnegative(sample.droppedPackets)) return null;
    if (sample.droppedTotal !== undefined && !finiteNonnegative(sample.droppedTotal) ||
        sample.phase !== undefined && !isBelaboxPhase(sample.phase) ||
        sample.alertStartedAt !== undefined && sample.alertStartedAt !== null && typeof sample.alertStartedAt !== "string") {
      return null;
    }
    return sample as unknown as BelaboxSample;
  } catch {
    return null;
  }
};

const parseFetchPhase = (value: string): BelaboxFetchPhase => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_FETCH_PHASE;
    const state = parsed as Readonly<Record<string, unknown>>;
    return Number.isSafeInteger(state.consecutiveFailures) && Number(state.consecutiveFailures) >= 0 &&
      typeof state.fetchFailing === "boolean"
      ? { consecutiveFailures: Number(state.consecutiveFailures), failing: state.fetchFailing }
      : EMPTY_FETCH_PHASE;
  } catch {
    return EMPTY_FETCH_PHASE;
  }
};

const parseRecent = (value: string): readonly BelaboxRecentPoint[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): BelaboxRecentPoint[] => {
      if (!Array.isArray(entry) || entry.length !== 4 || typeof entry[0] !== "string" ||
          !finiteNonnegative(entry[1]) || !finiteNonnegative(entry[2]) || typeof entry[3] !== "boolean") return [];
      return [{ at: entry[0], bitrateKbps: entry[1], rttMs: entry[2], connected: entry[3] }];
    });
  } catch {
    return [];
  }
};

const isAlertPhase = (value: unknown): value is BelaboxAlertState["phase"] =>
  value === "ok" || value === "pending" || value === "alarm" || value === "recovering";
const isAlertKind = (value: unknown): value is NonNullable<BelaboxAlertState["kind"]> =>
  value === "low" || value === "disconnect";

const parseAlertState = (value: string): BelaboxAlertState => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return createInitialAlertState();
    const state = parsed as Readonly<Record<string, unknown>>;
    if (!isAlertPhase(state.phase) || (state.kind !== null && !isAlertKind(state.kind)) ||
        (state.since !== null && typeof state.since !== "string") ||
        (state.episodeStartedAt !== null && typeof state.episodeStartedAt !== "string") ||
        (state.completedEpisodeAt !== null && typeof state.completedEpisodeAt !== "string") ||
        (state.lastChatSentAt !== null && typeof state.lastChatSentAt !== "string") ||
        typeof state.chatSentInEpisode !== "boolean") return createInitialAlertState();

    let pendingChat: BelaboxAlertState["pendingChat"] = null;
    if (typeof state.pendingChat === "object" && state.pendingChat !== null && !Array.isArray(state.pendingChat)) {
      const candidate = state.pendingChat as Readonly<Record<string, unknown>>;
      const validMessageKind = candidate.kind === "low" || candidate.kind === "disconnect" || candidate.kind === "recovery";
      const validIdempotencyKind = candidate.idempotencyKind === "alert" || candidate.idempotencyKind === "escalate" || candidate.idempotencyKind === "recovered";
      const validPhase = candidate.validPhase === "alarm" || candidate.validPhase === "ok";
      if (validMessageKind && validIdempotencyKind && typeof candidate.episodeStartedAt === "string" &&
          isAlertKind(candidate.alertKind) && validPhase && finiteNonnegative(candidate.threshold) &&
          Number.isSafeInteger(candidate.seconds) && Number(candidate.seconds) >= 0) {
        pendingChat = {
          kind: candidate.kind as BelaboxAlertMessageKind,
          idempotencyKind: candidate.idempotencyKind as BelaboxAlertIdempotencyKind,
          episodeStartedAt: candidate.episodeStartedAt,
          alertKind: candidate.alertKind,
          validPhase: candidate.validPhase as "alarm" | "ok",
          threshold: candidate.threshold,
          seconds: Number(candidate.seconds),
        };
      }
    }
    return {
      phase: state.phase,
      kind: state.kind,
      since: state.since,
      episodeStartedAt: state.episodeStartedAt,
      completedEpisodeAt: state.completedEpisodeAt,
      lastChatSentAt: state.lastChatSentAt,
      chatSentInEpisode: state.chatSentInEpisode,
      pendingChat,
    };
  } catch {
    return createInitialAlertState();
  }
};

const isStatusErrorCode = (value: string | null): value is BelaboxStatusErrorCode =>
  value !== null && [
    "timeout", "network", "http_4xx", "http_5xx", "redirect_rejected", "too_large", "malformed", "budget_exhausted",
    BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  ].includes(value);

export const getBelaboxStatus = async (db: D1Database, channelId: string): Promise<BelaboxStatus | null> => {
  const row = await db.prepare(
    `SELECT sampled_at, sample_json, error_code, polling, stream_id, stream_session_key, belabox_stream_id,
            fetch_phase_json, recent_json, alert_json, revision
       FROM belabox_status WHERE channel_id = ?`,
  ).bind(channelId).first<BelaboxStatusRow>();
  if (row === null) return null;
  return {
    sample: parseSample(row.sample_json),
    errorCode: isStatusErrorCode(row.error_code) ? row.error_code : null,
    polling: row.polling === 1,
    streamId: row.stream_id,
    streamSessionKey: row.stream_session_key,
    belaboxStreamId: row.belabox_stream_id,
    fetchPhase: parseFetchPhase(row.fetch_phase_json),
    recent: parseRecent(row.recent_json),
    alertState: parseAlertState(row.alert_json),
    revision: row.revision,
  };
};

export const getLatestBelaboxSample = async (db: D1Database, channelId: string): Promise<BelaboxSample | null> =>
  (await getBelaboxStatus(db, channelId))?.sample ?? null;

export const getBelaboxStreamSession = async (
  db: D1Database,
  channelId: string,
): Promise<BelaboxStreamSession | null> => {
  const row = await db.prepare(
    `SELECT state, changed_at, started_at, stream_id
       FROM channel_stream_state
      WHERE channel_id = ?`,
  ).bind(channelId).first<BelaboxStreamSessionRow>();
  return row === null ? null : {
    state: row.state,
    changedAt: row.changed_at,
    startedAt: row.started_at,
    streamId: row.stream_id,
  };
};

export const belaboxStreamSessionKey = (session: BelaboxStreamSession | null): string | null => {
  if (session === null) return null;
  if (session.state === "offline") return `offline:${session.changedAt}`;
  if (session.streamId !== null) return `stream:${session.streamId}`;
  if (session.startedAt !== null) return `started:${session.startedAt}:${session.changedAt}`;
  return `online:${session.changedAt}`;
};

export const sameBelaboxStreamSession = (
  left: BelaboxStreamSession | null,
  right: BelaboxStreamSession | null,
): boolean => belaboxStreamSessionKey(left) === belaboxStreamSessionKey(right);

export const belaboxStatusMatchesSession = (
  status: BelaboxStatus | null,
  session: BelaboxStreamSession | null,
): boolean => {
  if (status === null) return false;
  if (session === null) return status.streamId === null && status.streamSessionKey === null;
  const sessionKey = belaboxStreamSessionKey(session);
  return status.streamSessionKey === sessionKey || (
    status.streamSessionKey === null && session.state === "online" && session.streamId !== null &&
    status.streamId === session.streamId
  );
};

export const belaboxStreamSessionGuard = (
  channelId: string,
  session: BelaboxStreamSession | null | undefined,
): { sql: string; values: readonly (string | null)[] } => {
  if (session === undefined) return { sql: "", values: [] };
  if (session === null) {
    return {
      sql: "AND NOT EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ?)",
      values: [channelId],
    };
  }
  if (session.state === "offline") {
    return {
      sql: "AND EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'offline' AND changed_at = ?)",
      values: [channelId, session.changedAt],
    };
  }
  if (session.streamId !== null) {
    return {
      sql: "AND EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id = ?)",
      values: [channelId, session.streamId],
    };
  }
  if (session.startedAt !== null) {
    return {
      sql: "AND EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id IS NULL AND started_at IS ? AND changed_at = ?)",
      values: [channelId, session.startedAt, session.changedAt],
    };
  }
  return {
    sql: "AND EXISTS (SELECT 1 FROM channel_stream_state WHERE channel_id = ? AND state = 'online' AND stream_id IS NULL AND started_at IS NULL AND changed_at = ?)",
    values: [channelId, session.changedAt],
  };
};

const encodedRecent = (recent: readonly BelaboxRecentPoint[]): string => JSON.stringify(
  recent.map(({ at, bitrateKbps, rttMs, connected }) => [at, bitrateKbps, rttMs, connected]),
);

const encodedPhase = (phase: BelaboxFetchPhase): string => JSON.stringify({
  consecutiveFailures: phase.consecutiveFailures,
  fetchFailing: phase.failing,
});

export const setBelaboxPollingState = async (
  db: D1Database,
  channelId: string,
  polling: boolean,
  resetStream = false,
  errorCode?: BelaboxStatusErrorCode,
): Promise<boolean> => {
  if (polling) {
    const result = await db.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, NULL, NULL, ?, '[]', 1)
       ON CONFLICT (channel_id) DO UPDATE SET
         polling = 1,
         revision = belabox_status.revision + 1
       WHERE belabox_status.polling != 1`,
    ).bind(channelId, encodedPhase(EMPTY_FETCH_PHASE)).run();
    return result.meta.changes > 0;
  }

  if (errorCode !== undefined) {
    const result = await db.prepare(
      `INSERT INTO belabox_status
        (channel_id, error_code, polling, fetch_phase_json, recent_json, revision)
       VALUES (?, ?, 0, ?, '[]', 1)
       ON CONFLICT (channel_id) DO UPDATE SET
         polling = 0,
         error_code = ?,
         revision = belabox_status.revision + 1
       WHERE belabox_status.polling != 0 OR belabox_status.error_code IS NOT ?`,
    ).bind(channelId, errorCode, encodedPhase(EMPTY_FETCH_PHASE), errorCode, errorCode).run();
    return result.meta.changes > 0;
  }

  if (resetStream) {
    const result = await db.prepare(
      `UPDATE belabox_status SET
         sampled_at = NULL,
         sample_json = NULL,
         polling = 0,
         error_code = NULL,
         stream_id = NULL,
         stream_session_key = NULL,
         belabox_stream_id = NULL,
         fetch_phase_json = ?,
         recent_json = '[]',
         alert_json = '{}',
         revision = revision + 1
       WHERE channel_id = ? AND (
         polling != 0 OR stream_id IS NOT NULL OR belabox_stream_id IS NOT NULL OR
         sampled_at IS NOT NULL OR sample_json IS NOT NULL OR fetch_phase_json != ? OR recent_json != '[]' OR alert_json != '{}'
       )`,
    ).bind(encodedPhase(EMPTY_FETCH_PHASE), channelId, encodedPhase(EMPTY_FETCH_PHASE)).run();
    return result.meta.changes > 0;
  }

  const result = await db.prepare(
    `UPDATE belabox_status
        SET polling = 0, revision = revision + 1
      WHERE channel_id = ? AND polling != 0`,
  ).bind(channelId).run();
  return result.meta.changes > 0;
};

export const writeBelaboxFetch = async (
  db: D1Database,
  input: {
    channelId: string;
    sample: BelaboxSample | null;
    errorCode: BelaboxFetchFailureReason | null;
    polling: boolean;
    streamId: string | null;
    streamSessionKey: string | null;
    belaboxStreamId: string | null;
    fetchPhase: BelaboxFetchPhase;
    alertState: BelaboxAlertState;
    recent: readonly BelaboxRecentPoint[];
    expectedSecretVersion: string;
    expectedStatusRevision: number | null;
    expectedStreamSession?: BelaboxStreamSession | null;
  },
): Promise<{ revision: number; sample: BelaboxSample | null } | null> => {
  const sessionGuard = belaboxStreamSessionGuard(input.channelId, input.expectedStreamSession);
  const row = await db.prepare(
    `INSERT INTO belabox_status
      (channel_id, sampled_at, sample_json, error_code, polling, stream_id, stream_session_key, belabox_stream_id,
       fetch_phase_json, recent_json, alert_json, revision)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
     WHERE EXISTS (
       SELECT 1 FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ? AND ciphertext = ?
     )
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM belabox_status
          WHERE channel_id = ? AND revision = ?
       ))
       ${sessionGuard.sql}
     ON CONFLICT (channel_id) DO UPDATE SET
       sampled_at = CASE
         WHEN belabox_status.stream_session_key IS NOT excluded.stream_session_key
         THEN excluded.sampled_at
         WHEN excluded.sampled_at IS NOT NULL AND
              (belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at)
         THEN excluded.sampled_at ELSE belabox_status.sampled_at END,
       sample_json = CASE
         WHEN belabox_status.stream_session_key IS NOT excluded.stream_session_key
         THEN excluded.sample_json
         WHEN excluded.sampled_at IS NOT NULL AND
              (belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at)
         THEN excluded.sample_json ELSE belabox_status.sample_json END,
       error_code = excluded.error_code,
       polling = excluded.polling,
       stream_id = excluded.stream_id,
       stream_session_key = excluded.stream_session_key,
       belabox_stream_id = excluded.belabox_stream_id,
       fetch_phase_json = excluded.fetch_phase_json,
       recent_json = excluded.recent_json,
       alert_json = excluded.alert_json,
       revision = belabox_status.revision + 1
     WHERE belabox_status.revision = ?
     RETURNING revision, sample_json`,
  ).bind(
    input.channelId,
    input.sample?.at ?? null,
    input.sample === null ? null : JSON.stringify(input.sample),
    input.errorCode,
    Number(input.polling),
    input.streamId,
    input.streamSessionKey,
    input.belaboxStreamId,
    encodedPhase(input.fetchPhase),
    encodedRecent(input.recent),
    JSON.stringify(input.alertState),
    input.channelId,
    BELABOX_MODULE_ID,
    BELABOX_STATS_URL_SECRET,
    input.expectedSecretVersion,
    input.expectedStatusRevision,
    input.channelId,
    input.expectedStatusRevision,
    ...sessionGuard.values,
    input.expectedStatusRevision ?? -1,
  ).first<{ revision: number; sample_json: string | null }>();
  return row === null ? null : { revision: row.revision, sample: parseSample(row.sample_json) };
};

/*
 * Poll status writes use the status row revision to avoid overwriting a newer
 * status or on-demand sample. Poll scheduling deliberately has no owner token:
 * lifecycle requests only ensure the alarm, whose handler reads current state.
 */
export const prepareBelaboxSampleWrite = (
  db: D1Database,
  channelId: string,
  sample: BelaboxSample,
  expectedSecretVersion: string,
  authorization: ModuleMutationAuthorization,
  options: {
    streamId?: string | null;
    streamSessionKey?: string | null;
    belaboxStreamId?: string | null;
    expectedStatusRevision?: number | null;
    expectedStreamSession?: BelaboxStreamSession | null;
  } = {},
): D1PreparedStatement => {
  const sessionGuard = belaboxStreamSessionGuard(channelId, options.expectedStreamSession);
  const hasExpectedRevision = options.expectedStatusRevision !== undefined;
  const expectedRevision = options.expectedStatusRevision ?? -1;
  return db.prepare(
    `INSERT INTO belabox_status
      (channel_id, sampled_at, sample_json, error_code, polling, stream_id, stream_session_key, belabox_stream_id,
       fetch_phase_json, recent_json, revision)
     SELECT ?, ?, ?, NULL, 0, ?, ?, ?, ?, '[]', 1 WHERE 1 = 1 ${authorization.sql}
       AND EXISTS (
         SELECT 1 FROM module_secrets
          WHERE channel_id = ? AND module_id = ? AND name = ? AND ciphertext = ?
       )
       AND (? = 0 OR (? IS NULL AND NOT EXISTS (
         SELECT 1 FROM belabox_status WHERE channel_id = ?
       )) OR EXISTS (
         SELECT 1 FROM belabox_status WHERE channel_id = ? AND revision = ?
       ))
       ${sessionGuard.sql}
     ON CONFLICT (channel_id) DO UPDATE SET
       sampled_at = CASE
         WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
         THEN excluded.sampled_at ELSE belabox_status.sampled_at END,
       sample_json = CASE
         WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
         THEN excluded.sample_json ELSE belabox_status.sample_json END,
       stream_id = CASE
         WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
         THEN excluded.stream_id ELSE belabox_status.stream_id END,
       stream_session_key = CASE
         WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
         THEN excluded.stream_session_key ELSE belabox_status.stream_session_key END,
       belabox_stream_id = CASE
         WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
         THEN excluded.belabox_stream_id ELSE belabox_status.belabox_stream_id END,
       error_code = NULL,
       revision = belabox_status.revision + 1
     WHERE (? = 0 OR belabox_status.revision = ?)`,
  ).bind(
    channelId,
    sample.at,
    JSON.stringify(sample),
    options.streamId ?? null,
    options.streamSessionKey ?? null,
    options.belaboxStreamId ?? null,
    encodedPhase(EMPTY_FETCH_PHASE),
    ...authorization.values,
    channelId,
    BELABOX_MODULE_ID,
    BELABOX_STATS_URL_SECRET,
    expectedSecretVersion,
    Number(hasExpectedRevision),
    options.expectedStatusRevision ?? null,
    channelId,
    channelId,
    options.expectedStatusRevision ?? null,
    ...sessionGuard.values,
    Number(hasExpectedRevision),
    expectedRevision,
  );
};

export const writeBelaboxAlertState = async (
  db: D1Database,
  channelId: string,
  alertState: BelaboxAlertState,
  expectedRevision: number,
): Promise<number | null> => {
  const row = await db.prepare(
    `UPDATE belabox_status
        SET alert_json = ?, revision = revision + 1
      WHERE channel_id = ? AND revision = ?
      RETURNING revision`,
  ).bind(JSON.stringify(alertState), channelId, expectedRevision).first<{ revision: number }>();
  return row?.revision ?? null;
};

export const prepareBelaboxSampleClear = (
  db: D1Database,
  channelId: string,
  authorization: ModuleMutationAuthorization,
): D1PreparedStatement => db.prepare(
  `UPDATE belabox_status
      SET sampled_at = NULL,
          sample_json = NULL,
          error_code = NULL,
          stream_session_key = NULL,
          belabox_stream_id = NULL,
          fetch_phase_json = ?,
          recent_json = '[]',
          alert_json = '{}',
          revision = revision + 1
    WHERE channel_id = ? ${authorization.sql}`,
).bind(encodedPhase(EMPTY_FETCH_PHASE), channelId, ...authorization.values);
