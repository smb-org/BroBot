import type { ModuleMutationAuthorization } from "../../contract";
import {
  BELABOX_MODULE_ID,
  BELABOX_STATS_URL_SECRET,
  type BelaboxFetchFailureReason,
  type BelaboxSample,
} from "../contracts";

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
  errorCode: BelaboxFetchFailureReason | null;
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

const isFailureReason = (value: string | null): value is BelaboxFetchFailureReason =>
  value !== null && [
    "timeout", "network", "http_4xx", "http_5xx", "redirect_rejected", "too_large", "malformed", "budget_exhausted",
  ].includes(value);

export const getBelaboxStatus = async (db: D1Database, channelId: string): Promise<BelaboxStatus | null> => {
  const row = await db.prepare(
    `SELECT sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id,
            fetch_phase_json, recent_json, revision
       FROM belabox_status WHERE channel_id = ?`,
  ).bind(channelId).first<BelaboxStatusRow>();
  if (row === null) return null;
  return {
    sample: parseSample(row.sample_json),
    errorCode: isFailureReason(row.error_code) ? row.error_code : null,
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
): Promise<void> => {
  if (polling) {
    await db.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, NULL, NULL, ?, '[]', 1)
       ON CONFLICT (channel_id) DO UPDATE SET
         polling = 1,
         revision = belabox_status.revision + 1
       WHERE belabox_status.polling != 1`,
    ).bind(channelId, encodedPhase(EMPTY_FETCH_PHASE)).run();
    return;
  }

  if (resetStream) {
    await db.prepare(
      `UPDATE belabox_status SET
         polling = 0,
         error_code = NULL,
         stream_id = NULL,
         belabox_stream_id = NULL,
         fetch_phase_json = ?,
         recent_json = '[]',
         revision = revision + 1
       WHERE channel_id = ? AND (
         polling != 0 OR stream_id IS NOT NULL OR belabox_stream_id IS NOT NULL OR
         fetch_phase_json != ? OR recent_json != '[]'
       )`,
    ).bind(encodedPhase(EMPTY_FETCH_PHASE), channelId, encodedPhase(EMPTY_FETCH_PHASE)).run();
    return;
  }

  await db.prepare(
    `UPDATE belabox_status
        SET polling = 0, revision = revision + 1
      WHERE channel_id = ? AND polling != 0`,
  ).bind(channelId).run();
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
  },
): Promise<number | null> => {
  const row = await db.prepare(
    `INSERT INTO belabox_status
      (channel_id, sampled_at, sample_json, error_code, polling, stream_id, belabox_stream_id,
       fetch_phase_json, recent_json, revision)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
     WHERE EXISTS (
       SELECT 1 FROM module_secrets
        WHERE channel_id = ? AND module_id = ? AND name = ? AND ciphertext = ?
     )
       AND (? IS NULL OR EXISTS (
         SELECT 1 FROM belabox_status
          WHERE channel_id = ? AND revision = ?
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
       revision = belabox_status.revision + 1
     WHERE belabox_status.revision = ?
     RETURNING revision`,
  ).bind(
    input.channelId,
    input.sample?.at ?? null,
    input.sample === null ? null : JSON.stringify(input.sample),
    input.errorCode,
    Number(input.polling),
    input.streamId,
    input.belaboxStreamId,
    encodedPhase(input.fetchPhase),
    encodedRecent(input.recent),
    input.channelId,
    BELABOX_MODULE_ID,
    BELABOX_STATS_URL_SECRET,
    input.expectedSecretVersion,
    input.expectedStatusRevision,
    input.channelId,
    input.expectedStatusRevision,
    input.expectedStatusRevision ?? -1,
  ).first<{ revision: number }>();
  return row?.revision ?? null;
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
