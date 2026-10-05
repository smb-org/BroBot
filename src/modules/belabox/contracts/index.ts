export const BELABOX_MODULE_ID = "belabox";
export const BELABOX_STATS_URL_SECRET = "stats_url";
export const BELABOX_STATS_RESPONSE_MAX_BYTES = 16 * 1024;
export const BELABOX_STATS_TIMEOUT_MS = 3_000;

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
}

export type BelaboxFetchResult =
  | { ok: true; sample: BelaboxSample }
  | { ok: false; reason: BelaboxFetchFailureReason };

export type BelaboxTestResult =
  | { ok: true; connected: boolean; bitrateKbps: number }
  | { ok: false; reason: BelaboxFetchFailureReason | BelaboxStatsUrlError | "not_configured" };
