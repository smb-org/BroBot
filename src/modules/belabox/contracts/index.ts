import { z } from "zod";

export const BELABOX_MODULE_ID = "belabox";
export const BELABOX_STATS_URL_SECRET = "stats_url";
export const BELABOX_STATS_RESPONSE_MAX_BYTES = 16 * 1024;
export const BELABOX_STATS_TIMEOUT_MS = 3_000;
export const BELABOX_POLL_ALARM_KEY = "poll";
export const BELABOX_ENSURE_POLL_HANDLER = "ensure";
export const BELABOX_PROBE_INTERVAL_MS = 60_000;
export const BELABOX_ON_DEMAND_CACHE_MS = 10_000;

export const belaboxSettingsSchema = z.object({
  mode: z.enum(["interval", "on_demand"]).default("interval"),
  intervalSeconds: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).default(15),
});
export type BelaboxSettings = z.output<typeof belaboxSettingsSchema>;
export const BELABOX_DEFAULT_SETTINGS: BelaboxSettings = { mode: "interval", intervalSeconds: 15 };

export type BelaboxStatsUrlError =
  | "invalid_url"
  | "invalid_scheme"
  | "invalid_port"
  | "invalid_host"
  | "credentials_not_allowed"
  | "query_not_allowed"
  | "fragment_not_allowed"
  | "invalid_path";

export type BelaboxFetchFailureReason =
  | "timeout"
  | "network"
  | "http_4xx"
  | "http_5xx"
  | "redirect_rejected"
  | "too_large"
  | "malformed"
  | "budget_exhausted";

export interface BelaboxStats {
  connected: boolean;
  /** Assumption pending the owner's live check: relay `bitrate` is kbps. */
  bitrateKbps: number;
  /** Assumption pending the owner's live check: relay `rtt` is milliseconds. */
  rttMs: number;
  /** Assumption pending the owner's live check: relay `latency` is milliseconds. */
  latencyMs: number;
  /** Assumption pending the owner's live check: relay `network` is a unitless numeric value. */
  network: number;
  droppedPackets: number;
}

export interface BelaboxSample extends BelaboxStats {
  at: string;
}

export interface BelaboxStatusResponse {
  configured: boolean;
  updatedAt: string | null;
  sample: BelaboxSample | null;
  errorCode: BelaboxFetchFailureReason | null;
  polling: boolean;
  pollingDesired: boolean;
  streamId: string | null;
  belaboxStreamId: string | null;
}

export type BelaboxFetchResult =
  | { ok: true; sample: BelaboxSample }
  | { ok: false; reason: BelaboxFetchFailureReason };

export type BelaboxTestResult =
  | { ok: true; connected: boolean; bitrateKbps: number }
  | { ok: false; reason: BelaboxFetchFailureReason | BelaboxStatsUrlError | "not_configured" };
