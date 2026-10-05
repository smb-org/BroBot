import type { ModuleMutationAuthorization } from "../../contract";
import type { BelaboxSample } from "../contracts";

interface BelaboxStatusRow {
  connected: number;
  bitrate_kbps: number;
  rtt_ms: number;
  latency_ms: number;
  network: number;
  dropped_packets: number;
  sampled_at: string;
}

export const getLatestBelaboxSample = async (db: D1Database, channelId: string): Promise<BelaboxSample | null> => {
  const row = await db.prepare(
    `SELECT connected, bitrate_kbps, rtt_ms, latency_ms, network, dropped_packets, sampled_at
       FROM belabox_status WHERE channel_id = ?`,
  ).bind(channelId).first<BelaboxStatusRow>();
  if (row === null) return null;
  return {
    at: row.sampled_at,
    connected: row.connected === 1,
    bitrateKbps: row.bitrate_kbps,
    rttMs: row.rtt_ms,
    latencyMs: row.latency_ms,
    network: row.network,
    droppedPackets: row.dropped_packets,
  };
};

export const prepareBelaboxSampleWrite = (
  db: D1Database,
  channelId: string,
  sample: BelaboxSample,
  authorization: ModuleMutationAuthorization,
): D1PreparedStatement => db.prepare(
  `INSERT INTO belabox_status
    (channel_id, connected, bitrate_kbps, rtt_ms, latency_ms, network, dropped_packets, sampled_at)
   SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE 1 = 1 ${authorization.sql}
   ON CONFLICT (channel_id) DO UPDATE SET
     connected = excluded.connected,
     bitrate_kbps = excluded.bitrate_kbps,
     rtt_ms = excluded.rtt_ms,
     latency_ms = excluded.latency_ms,
     network = excluded.network,
     dropped_packets = excluded.dropped_packets,
     sampled_at = excluded.sampled_at`,
).bind(channelId, Number(sample.connected), sample.bitrateKbps, sample.rttMs, sample.latencyMs,
  sample.network, sample.droppedPackets, sample.at, ...authorization.values);

export const prepareBelaboxSampleClear = (
  db: D1Database,
  channelId: string,
  authorization: ModuleMutationAuthorization,
): D1PreparedStatement => db.prepare(
  `DELETE FROM belabox_status WHERE channel_id = ? ${authorization.sql}`,
).bind(channelId, ...authorization.values);
