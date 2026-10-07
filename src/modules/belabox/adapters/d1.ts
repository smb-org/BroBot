import type { ModuleMutationAuthorization } from "../../contract";
import {
  BELABOX_MODULE_ID,
  BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  BELABOX_STREAM_HISTORY_LIMIT,
  BELABOX_STATS_URL_SECRET,
  type BelaboxFetchFailureReason,
  type BelaboxStatusErrorCode,
  type BelaboxSample,
  type BelaboxHistoryPoint,
  type BelaboxStreamSummary,
} from "../contracts";
import {
  BELABOX_LOW_BITRATE_KBPS,
  bitrateP10,
  elapsedSampleSeconds,
} from "../domain/history";

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
  historySample: BelaboxSample | null;
  historyModuleRevision: number | null;
  errorCode: BelaboxStatusErrorCode | null;
  polling: boolean;
  streamId: string | null;
  belaboxStreamId: string | null;
  fetchPhase: BelaboxFetchPhase;
  recent: readonly BelaboxRecentPoint[];
  revision: number;
}

interface BelaboxStatusRow {
  sampled_at: string | null;
  sample_json: string | null;
  history_sample_json: string | null;
  history_module_revision: number | null;
  error_code: string | null;
  polling: number;
  stream_id: string | null;
  belabox_stream_id: string | null;
  fetch_phase_json: string;
  recent_json: string;
  revision: number;
}

const EMPTY_FETCH_PHASE: BelaboxFetchPhase = { consecutiveFailures: 0, failing: false };

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

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

const isStatusErrorCode = (value: string | null): value is BelaboxStatusErrorCode =>
  value !== null && [
    "timeout", "network", "http_4xx", "http_5xx", "redirect_rejected", "too_large", "malformed", "budget_exhausted",
    BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  ].includes(value);

export const getBelaboxStatus = async (db: D1Database, channelId: string): Promise<BelaboxStatus | null> => {
  const row = await db.prepare(
    `SELECT sampled_at, sample_json, history_sample_json, history_module_revision,
            error_code, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision
       FROM belabox_status WHERE channel_id = ?`,
  ).bind(channelId).first<BelaboxStatusRow>();
  if (row === null) return null;
  return {
    sample: parseSample(row.sample_json),
    historySample: parseSample(row.history_sample_json),
    historyModuleRevision: row.history_module_revision,
    errorCode: isStatusErrorCode(row.error_code) ? row.error_code : null,
    polling: row.polling === 1,
    streamId: row.stream_id,
    belaboxStreamId: row.belabox_stream_id,
    fetchPhase: parseFetchPhase(row.fetch_phase_json),
    recent: parseRecent(row.recent_json),
    revision: row.revision,
  };
};

export const getLatestBelaboxSample = async (db: D1Database, channelId: string): Promise<BelaboxSample | null> =>
  (await getBelaboxStatus(db, channelId))?.sample ?? null;

export const getBelaboxLiveHistory = async (db: D1Database, channelId: string, now = Date.now()): Promise<BelaboxHistoryPoint[]> => {
  const status = await getBelaboxStatus(db, channelId);
  if (status === null) return [];
  const cutoff = now - 10 * 60_000;
  return status.recent.flatMap(({ at, bitrateKbps, connected }) => {
    const timestamp = Date.parse(at);
    return Number.isFinite(timestamp) && timestamp >= cutoff
      ? [[timestamp, bitrateKbps, Number(connected)] as const]
      : [];
  });
};

export const getBelaboxStreamHistory = async (
  db: D1Database,
  channelId: string,
  streamId: string,
): Promise<BelaboxHistoryPoint[]> => {
  const result = await db.prepare(
    `SELECT minute_at, samples, connected_samples, bitrate_sum
       FROM belabox_minutes
      WHERE channel_id = ? AND stream_id = ?
      ORDER BY minute_at ASC`,
  ).bind(channelId, streamId).all<{
    minute_at: string;
    samples: number;
    connected_samples: number;
    bitrate_sum: number;
  }>();
  return result.results.flatMap((row) => {
    const timestamp = Date.parse(row.minute_at);
    if (!Number.isFinite(timestamp) || !Number.isFinite(row.samples) || row.samples < 1 ||
        !Number.isFinite(row.connected_samples) || !Number.isFinite(row.bitrate_sum)) return [];
    return [[timestamp, row.bitrate_sum / row.samples, row.connected_samples / row.samples] as const];
  });
};

export const listBelaboxStreams = async (db: D1Database, channelId: string): Promise<BelaboxStreamSummary[]> => {
  const result = await db.prepare(
    `SELECT stream_id, started_at, ended_at, samples, bitrate_avg, bitrate_p10,
            low_seconds, disconnected_seconds, disconnect_count, dropped_total
       FROM belabox_streams
      WHERE channel_id = ?
      ORDER BY started_at DESC
      LIMIT ?`,
  ).bind(channelId, BELABOX_STREAM_HISTORY_LIMIT).all<{
    stream_id: string;
    started_at: string;
    ended_at: string | null;
    samples: number;
    bitrate_avg: number;
    bitrate_p10: number | null;
    low_seconds: number;
    disconnected_seconds: number;
    disconnect_count: number;
    dropped_total: number;
  }>();
  return result.results.map((row) => ({
    streamId: row.stream_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    samples: row.samples,
    bitrateAvg: row.bitrate_avg,
    bitrateP10: row.bitrate_p10,
    lowSeconds: row.low_seconds,
    disconnectedSeconds: row.disconnected_seconds,
    disconnectCount: row.disconnect_count,
    droppedTotal: row.dropped_total,
  }));
};

export const belaboxHistoryModuleRevisionGuard = `(
  (? IS NULL AND NOT EXISTS (
    SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'
  )) OR EXISTS (
    SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox' AND revision = ?
  )
)`;

/** Finalizes summaries and resets their sample baseline in one revision-guarded D1 batch. */
export const finalizeAndResetBelaboxHistory = async (
  db: D1Database,
  channelId: string,
  endedAt: string,
  expectedModuleRevision: number | null,
  options: {
    finalizeOpen?: boolean;
    resetStream?: boolean;
    stopPolling?: boolean;
    errorCode?: BelaboxStatusErrorCode;
  } = {},
): Promise<boolean> => {
  const [openStreams, status] = await Promise.all([
    db.prepare(
      `SELECT stream_id, started_at FROM belabox_streams
        WHERE channel_id = ? AND ended_at IS NULL`,
    ).bind(channelId).all<{ stream_id: string; started_at: string }>(),
    getBelaboxStatus(db, channelId),
  ]);
  const ending = Date.parse(endedAt);
  const normalizedEndedAt = Number.isFinite(ending) ? new Date(ending).toISOString() : new Date().toISOString();
  const finalizers = options.finalizeOpen === false ? [] : await Promise.all(openStreams.results.map(async (stream) => {
    const minutes = await db.prepare(
      `SELECT samples, bitrate_sum FROM belabox_minutes
        WHERE channel_id = ? AND stream_id = ?
        ORDER BY minute_at ASC`,
    ).bind(channelId, stream.stream_id).all<{ samples: number; bitrate_sum: number }>();
    const p10 = bitrateP10(minutes.results.flatMap((row) =>
      Number.isFinite(row.samples) && row.samples > 0 && Number.isFinite(row.bitrate_sum)
        ? [row.bitrate_sum / row.samples]
        : []));
    const sample = status?.streamId === stream.stream_id ? status.historySample : null;
    const tailSeconds = sample === null
      ? 0
      : elapsedSampleSeconds(sample, { ...sample, at: normalizedEndedAt });
    const lowTail = sample?.connected === true && sample.bitrateKbps < BELABOX_LOW_BITRATE_KBPS ? tailSeconds : 0;
    const disconnectedTail = sample?.connected === false ? tailSeconds : 0;
    return db.prepare(
      `UPDATE belabox_streams
          SET ended_at = ?,
              bitrate_p10 = ?,
              low_seconds = low_seconds + ?,
              disconnected_seconds = disconnected_seconds + ?
        WHERE channel_id = ? AND stream_id = ? AND started_at = ? AND ended_at IS NULL
          AND ${belaboxHistoryModuleRevisionGuard}`,
    ).bind(
      normalizedEndedAt,
      p10,
      lowTail,
      disconnectedTail,
      channelId,
      stream.stream_id,
      stream.started_at,
      expectedModuleRevision,
      channelId,
      channelId,
      expectedModuleRevision,
    );
  }));
  const assignments = [
    ...(options.stopPolling === false ? [] : ["polling = 0"]),
    "history_sample_json = NULL",
    "history_module_revision = NULL",
    ...(options.errorCode === undefined || options.resetStream === true ? [] : ["error_code = ?"]),
    ...(options.resetStream === true ? [
      "error_code = NULL",
      "stream_id = NULL",
      "belabox_stream_id = NULL",
      "fetch_phase_json = ?",
      "recent_json = '[]'",
    ] : []),
    "revision = revision + 1",
  ];
  const changes = [
    ...(options.stopPolling === false ? [] : ["polling != 0"]),
    "history_sample_json IS NOT NULL",
    "history_module_revision IS NOT NULL",
    ...(options.resetStream === true ? [
      "error_code IS NOT NULL",
      "stream_id IS NOT NULL",
      "belabox_stream_id IS NOT NULL",
      "recent_json != '[]'",
      `fetch_phase_json != '${encodedPhase(EMPTY_FETCH_PHASE)}'`,
    ] : []),
    ...(options.errorCode === undefined || options.resetStream === true ? [] : ["error_code IS NOT ?"]),
  ];
  const bindings: unknown[] = [];
  if (options.errorCode !== undefined && options.resetStream !== true) bindings.push(options.errorCode);
  if (options.resetStream === true) bindings.push(encodedPhase(EMPTY_FETCH_PHASE));
  bindings.push(channelId);
  if (options.errorCode !== undefined && options.resetStream !== true) bindings.push(options.errorCode);
  bindings.push(expectedModuleRevision, channelId, channelId, expectedModuleRevision);
  const statusReset = db.prepare(
    `UPDATE belabox_status
        SET ${assignments.join(",\n            ")}
      WHERE channel_id = ? AND (${changes.join(" OR ")})
        AND ${belaboxHistoryModuleRevisionGuard}`,
  ).bind(...bindings);
  const statusSeed = options.errorCode === undefined ? [] : [db.prepare(
    `INSERT INTO belabox_status
      (channel_id, error_code, polling, fetch_phase_json, recent_json, revision)
     SELECT ?, ?, 0, ?, '[]', 1
      WHERE NOT EXISTS (SELECT 1 FROM belabox_status WHERE channel_id = ?)
        AND ${belaboxHistoryModuleRevisionGuard}`,
  ).bind(
    channelId,
    options.errorCode,
    encodedPhase(EMPTY_FETCH_PHASE),
    channelId,
    expectedModuleRevision,
    channelId,
    channelId,
    expectedModuleRevision,
  )];
  await db.batch([...finalizers, ...statusSeed, statusReset]);
  const currentModule = await db.prepare(
    "SELECT revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
  ).bind(channelId).first<{ revision: number }>();
  return (currentModule?.revision ?? null) === expectedModuleRevision;
};

/** Reopens a previously finalized row only after the serialized poll alarm sees the live stream. */
export const reopenCurrentBelaboxStream = async (
  db: D1Database,
  channelId: string,
  expectedModuleRevision: number,
): Promise<void> => {
  await db.prepare(
    `UPDATE belabox_streams
        SET ended_at = NULL, bitrate_p10 = NULL
      WHERE channel_id = ? AND ended_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM channel_stream_state
           WHERE channel_id = belabox_streams.channel_id
             AND state = 'online'
             AND stream_id = belabox_streams.stream_id
        )
        AND EXISTS (
          SELECT 1 FROM channel_modules
           WHERE channel_id = ? AND module_id = 'belabox' AND enabled = 1
             AND revision = ? AND json_extract(settings, '$.mode') = 'interval'
        )`,
  ).bind(channelId, channelId, expectedModuleRevision).run();
};

export const belaboxStreamExists = async (
  db: D1Database,
  channelId: string,
  streamId: string,
): Promise<boolean> => (await db.prepare(
  "SELECT 1 AS present FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
).bind(channelId, streamId).first<{ present: number }>()) !== null;

export const purgeExpiredBelaboxMinutes = async (db: D1Database, now: string): Promise<void> => {
  const cutoff = new Date(Date.parse(now) - 30 * 24 * 60 * 60_000).toISOString();
  const channels = await db.prepare("SELECT channel_id FROM channels").all<{ channel_id: string }>();
  const batchSize = 50;
  for (let offset = 0; offset < channels.results.length; offset += batchSize) {
    const deletes = channels.results.slice(offset, offset + batchSize).map(({ channel_id }) =>
      db.prepare("DELETE FROM belabox_minutes WHERE channel_id = ? AND minute_at < ?").bind(channel_id, cutoff));
    await db.batch(deletes);
  }
};

const encodedRecent = (recent: readonly BelaboxRecentPoint[]): string => JSON.stringify(
  recent.map(({ at, bitrateKbps, rttMs, connected }) => [at, bitrateKbps, rttMs, connected]),
);

const encodedPhase = (phase: BelaboxFetchPhase): string => JSON.stringify({
  consecutiveFailures: phase.consecutiveFailures,
  fetchFailing: phase.failing,
});

export const belaboxHistoryStatusGuard = `WHERE EXISTS (
    SELECT 1 FROM belabox_status
     WHERE channel_id = ? AND revision = ? AND history_sample_json = ?
       AND stream_id = ? AND belabox_stream_id = ?
  )`;

export const markBelaboxPollingStarted = async (
  db: D1Database,
  channelId: string,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO belabox_status
      (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
     VALUES (?, 1, NULL, NULL, ?, '[]', 1)
     ON CONFLICT (channel_id) DO UPDATE SET
       polling = 1,
       revision = belabox_status.revision + 1
     WHERE belabox_status.polling != 1`,
  ).bind(channelId, encodedPhase(EMPTY_FETCH_PHASE)).run();
};

export const writeBelaboxFetch = async (
  db: D1Database,
  input: {
    channelId: string;
    sample: BelaboxSample | null;
    errorCode: BelaboxFetchFailureReason | null;
    polling: boolean;
    streamId: string | null;
    belaboxStreamId: string | null;
    fetchPhase: BelaboxFetchPhase;
    recent: readonly BelaboxRecentPoint[];
    expectedSecretVersion: string;
    expectedStatusRevision: number | null;
    expectedModuleRevision?: number | null;
    historySample?: BelaboxSample | null;
    resetHistoryBaseline?: boolean;
    historyModuleRevision?: number | null;
    history?: {
      streamId: string;
      startedAt: string;
      minuteAt: string;
      droppedDelta: number;
      lowSeconds: number;
      disconnectedSeconds: number;
      disconnectCount: number;
    };
  },
): Promise<number | null> => {
  const sampleJson = input.sample === null ? null : JSON.stringify(input.sample);
  const historySampleJson = input.history === undefined ? null : JSON.stringify(input.historySample ?? input.sample);
  const historyModuleRevision = input.history === undefined ? null : input.historyModuleRevision ?? null;
  const statusWrite = db.prepare(
    `INSERT INTO belabox_status
      (channel_id, sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id,
       fetch_phase_json, recent_json, history_sample_json, history_module_revision, revision)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
     WHERE EXISTS (
       SELECT 1 FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ? AND ciphertext = ?
     )
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM belabox_status
          WHERE channel_id = ? AND revision = ?
       ))
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM channel_modules
          WHERE channel_id = ? AND module_id = 'belabox' AND enabled = 1
            AND revision = ? AND json_extract(settings, '$.mode') = 'interval'
       ))
     ON CONFLICT (channel_id) DO UPDATE SET
       sampled_at = CASE
         WHEN excluded.sampled_at IS NOT NULL AND
              (belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at)
         THEN excluded.sampled_at ELSE belabox_status.sampled_at END,
       sample_json = CASE
         WHEN excluded.sampled_at IS NOT NULL AND
              (belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at)
         THEN excluded.sample_json ELSE belabox_status.sample_json END,
       error_code = excluded.error_code,
       polling = excluded.polling,
       stream_id = excluded.stream_id,
       belabox_stream_id = excluded.belabox_stream_id,
       fetch_phase_json = excluded.fetch_phase_json,
       recent_json = excluded.recent_json,
       history_sample_json = CASE
         WHEN ? = 1 THEN excluded.history_sample_json
         WHEN ? = 1 THEN NULL
         ELSE belabox_status.history_sample_json
       END,
       history_module_revision = CASE
         WHEN ? = 1 THEN excluded.history_module_revision
         WHEN ? = 1 THEN NULL
         ELSE belabox_status.history_module_revision
       END,
       revision = belabox_status.revision + 1
     WHERE belabox_status.revision = ?
     RETURNING revision`,
  ).bind(
    input.channelId,
    input.sample?.at ?? null,
    sampleJson,
    input.errorCode,
    Number(input.polling),
    input.streamId,
    input.belaboxStreamId,
    encodedPhase(input.fetchPhase),
    encodedRecent(input.recent),
    historySampleJson,
    historyModuleRevision,
    input.channelId,
    BELABOX_MODULE_ID,
    BELABOX_STATS_URL_SECRET,
    input.expectedSecretVersion,
    input.expectedStatusRevision,
    input.channelId,
    input.expectedStatusRevision,
    input.expectedModuleRevision ?? null,
    input.channelId,
    input.expectedModuleRevision ?? null,
    Number(input.history !== undefined),
    Number(input.resetHistoryBaseline === true),
    Number(input.history !== undefined),
    Number(input.resetHistoryBaseline === true),
    input.expectedStatusRevision ?? -1,
  );
  if (input.history === undefined || input.sample === null || sampleJson === null || historySampleJson === null) {
    const row = await statusWrite.first<{ revision: number }>();
    return row?.revision ?? null;
  }

  const nextRevision = (input.expectedStatusRevision ?? 0) + 1;
  const { history } = input;
  const sample = input.sample;
  const minuteWrite = db.prepare(
    `INSERT INTO belabox_minutes
      (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
       bitrate_sum, rtt_max, rtt_sum, dropped_delta)
     SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?
     ${belaboxHistoryStatusGuard}
     ON CONFLICT (channel_id, minute_at, stream_id) DO UPDATE SET
       samples = belabox_minutes.samples + 1,
       connected_samples = belabox_minutes.connected_samples + excluded.connected_samples,
       bitrate_min = MIN(belabox_minutes.bitrate_min, excluded.bitrate_min),
       bitrate_max = MAX(belabox_minutes.bitrate_max, excluded.bitrate_max),
       bitrate_sum = belabox_minutes.bitrate_sum + excluded.bitrate_sum,
       rtt_max = MAX(belabox_minutes.rtt_max, excluded.rtt_max),
       rtt_sum = belabox_minutes.rtt_sum + excluded.rtt_sum,
       dropped_delta = belabox_minutes.dropped_delta + excluded.dropped_delta`,
  ).bind(
    input.channelId,
    history.minuteAt,
    history.streamId,
    Number(sample.connected),
    sample.bitrateKbps,
    sample.bitrateKbps,
    sample.bitrateKbps,
    sample.rttMs,
    sample.rttMs,
    history.droppedDelta,
    input.channelId,
    nextRevision,
    historySampleJson,
    history.streamId,
    history.streamId,
  );
  const streamWrite = db.prepare(
    `INSERT INTO belabox_streams
      (channel_id, stream_id, started_at, ended_at, samples, bitrate_avg, bitrate_p10,
       low_seconds, disconnected_seconds, disconnect_count, dropped_total)
     SELECT ?, ?, ?, NULL, 1, ?, NULL, ?, ?, ?, ?
     ${belaboxHistoryStatusGuard}
     ON CONFLICT (channel_id, stream_id) DO UPDATE SET
       samples = belabox_streams.samples + 1,
       bitrate_avg = ((belabox_streams.bitrate_avg * belabox_streams.samples) + excluded.bitrate_avg) /
                     (belabox_streams.samples + 1),
       low_seconds = belabox_streams.low_seconds + excluded.low_seconds,
       disconnected_seconds = belabox_streams.disconnected_seconds + excluded.disconnected_seconds,
       disconnect_count = belabox_streams.disconnect_count + excluded.disconnect_count,
       dropped_total = belabox_streams.dropped_total + excluded.dropped_total
     WHERE belabox_streams.ended_at IS NULL`,
  ).bind(
    input.channelId,
    history.streamId,
    history.startedAt,
    sample.bitrateKbps,
    history.lowSeconds,
    history.disconnectedSeconds,
    history.disconnectCount,
    history.droppedDelta,
    input.channelId,
    nextRevision,
    historySampleJson,
    history.streamId,
    history.streamId,
  );
  const results = await db.batch([statusWrite, minuteWrite, streamWrite]);
  return (results[0]?.meta.changes ?? 0) > 0 ? nextRevision : null;
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
): D1PreparedStatement => db.prepare(
  `INSERT INTO belabox_status
    (channel_id, sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id,
     fetch_phase_json, recent_json, revision)
   SELECT ?, ?, ?, NULL, 0, NULL, NULL, ?, '[]', 1 WHERE 1 = 1 ${authorization.sql}
     AND EXISTS (
       SELECT 1 FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ? AND ciphertext = ?
     )
   ON CONFLICT (channel_id) DO UPDATE SET
     sampled_at = CASE
       WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
       THEN excluded.sampled_at ELSE belabox_status.sampled_at END,
     sample_json = CASE
       WHEN belabox_status.sampled_at IS NULL OR excluded.sampled_at > belabox_status.sampled_at
       THEN excluded.sample_json ELSE belabox_status.sample_json END,
    error_code = NULL,
     revision = belabox_status.revision + 1`,
).bind(channelId, sample.at, JSON.stringify(sample), encodedPhase(EMPTY_FETCH_PHASE), ...authorization.values,
  channelId, BELABOX_MODULE_ID, BELABOX_STATS_URL_SECRET, expectedSecretVersion);

export const prepareBelaboxSampleClear = (
  db: D1Database,
  channelId: string,
  authorization: ModuleMutationAuthorization,
): D1PreparedStatement => db.prepare(
  `UPDATE belabox_status
      SET sampled_at = NULL,
          sample_json = NULL,
          error_code = NULL,
          belabox_stream_id = NULL,
          fetch_phase_json = ?,
          recent_json = '[]',
          revision = revision + 1
    WHERE channel_id = ? ${authorization.sql}`,
).bind(encodedPhase(EMPTY_FETCH_PHASE), channelId, ...authorization.values);
