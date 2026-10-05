import type { BelaboxStatsUrlError } from "../contracts";

export const BELABOX_STATS_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.belabox\.net$/u;
const BELABOX_STATS_PATH_PATTERN = /^\/[A-Za-z0-9._~-]{8,256}$/u;
const RAW_URL_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#\\]*)(\/[^?#\\]*)?$/u;

export type BelaboxStatsUrlValidation =
  | { ok: true; url: URL; publisherKey: string }
  | { ok: false; reason: BelaboxStatsUrlError };

export const publisherKeyFromUrl = (url: URL): string => url.pathname.slice(1);

export const validateBelaboxStatsUrl = (input: string): BelaboxStatsUrlValidation => {
  if (input.length === 0 || input.length > 1_024 || input !== input.trim() || input.includes("\\")) {
    return { ok: false, reason: "invalid_url" };
  }
  if (input.includes("?")) return { ok: false, reason: "query_not_allowed" };
  if (input.includes("#")) return { ok: false, reason: "fragment_not_allowed" };

  const rawMatch = RAW_URL_PATTERN.exec(input);
  if (rawMatch === null) return { ok: false, reason: "invalid_url" };
  if (rawMatch[1]?.includes("@") === true) return { ok: false, reason: "credentials_not_allowed" };
  const rawPath = rawMatch[2] ?? "";
  if (!BELABOX_STATS_PATH_PATTERN.test(rawPath)) return { ok: false, reason: "invalid_path" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "invalid_scheme" };
  }
  if (url.protocol === "http:" ? url.port !== "8080" : url.port !== "") {
    return { ok: false, reason: "invalid_port" };
  }
  if (!BELABOX_STATS_HOST_PATTERN.test(url.hostname)) return { ok: false, reason: "invalid_host" };
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, reason: "credentials_not_allowed" };
  if (url.search.length > 0) return { ok: false, reason: "query_not_allowed" };
  if (url.hash.length > 0) return { ok: false, reason: "fragment_not_allowed" };
  if (url.pathname !== rawPath || !BELABOX_STATS_PATH_PATTERN.test(url.pathname)) {
    return { ok: false, reason: "invalid_path" };
  }

  return { ok: true, url, publisherKey: publisherKeyFromUrl(url) };
};
