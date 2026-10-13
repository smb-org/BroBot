import { readBoundedJsonResponseWithBytes } from "../../contract";
import type { ModuleExternalFetchBudget } from "../../contract";
import type { ApiSourceFailureReason } from "../contracts";
import { API_SOURCE_MAXIMUMS } from "../contracts";
import { claimApiSourceQuota, readCachedApiPayload, storeCachedApiPayload } from "./d1";
import { validateApiSourceUrl } from "../domain/url";

const API_SOURCE_TIMEOUT_MS = 3_000;
const API_SOURCE_RESPONSE_MAXIMUM_BYTES = 64 * 1024;
const API_SOURCE_DEFAULT_CACHE_TTL_MS = 60_000;
const API_SOURCE_MAXIMUM_CACHE_TTL_MS = 5 * 60_000;
const API_SOURCE_MAXIMUM_REDIRECTS = 3;
const API_SOURCE_USER_AGENT = "BroBot/0.1.0 (+https://github.com/smb-org/BroBot)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ApiSourceFetchError extends Error {
  readonly reason: ApiSourceFailureReason;
  readonly fetchedAt: string | null;
  readonly httpStatus?: number;
  readonly retryAfter?: number | null;

  constructor(
    reason: ApiSourceFailureReason,
    message: string,
    fetchedAt: string | null,
    httpStatus?: number,
    retryAfter?: number | null,
  ) {
    super(message);
    this.name = "ApiSourceFetchError";
    this.reason = reason;
    this.fetchedAt = fetchedAt;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export interface ApiSourceJsonResponse {
  payload: unknown;
  httpStatus: number;
  bytes: number;
  fetchedAt: string;
  expiresAt: number | null;
}

export interface CachedApiSourceJsonResponse extends Omit<ApiSourceJsonResponse, "fetchedAt" | "httpStatus" | "bytes"> {
  fetchedAt: string | null;
  httpStatus: number | null;
  bytes: number | null;
}

const cacheHash = async (channelId: string, url: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([channelId, url])));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const cacheExpiry = (headers: Headers, now: number): number | null => {
  const cacheControl = headers.get("Cache-Control") ?? "";
  if (/\b(?:private|no-store|no-cache)\b/iu.test(cacheControl)) return null;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl)?.[1];
  if (maxAge === undefined) return now + API_SOURCE_DEFAULT_CACHE_TTL_MS;
  return now + Math.min(API_SOURCE_MAXIMUM_CACHE_TTL_MS, Number(maxAge) * 1_000);
};

const cancelBody = async (response: Response): Promise<void> => {
  try { await response.body?.cancel(); } catch { /* The response is already being rejected. */ }
};

const requestJson = async (
  db: D1Database | null,
  channelId: string,
  inputUrl: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget: ModuleExternalFetchBudget | undefined,
  fetcher: typeof fetch,
  enforceQuota: boolean,
  disableEdgeCache = false,
): Promise<ApiSourceJsonResponse> => {
  const url = validateApiSourceUrl(inputUrl, ownOrigin);
  let current = url;
  let redirects = 0;
  const signal = AbortSignal.timeout(API_SOURCE_TIMEOUT_MS);
  for (;;) {
    validateApiSourceUrl(current.href, ownOrigin);
    if (externalFetchBudget !== undefined && !externalFetchBudget.claim()) {
      throw new ApiSourceFetchError(
        "rate_limited",
        "API source invocation request limit reached.",
        new Date(now).toISOString(),
        undefined,
        null,
      );
    }
    if (enforceQuota) {
      if (db === null) throw new Error("API source database is unavailable.");
      const withinQuota = await claimApiSourceQuota(db, channelId, now, API_SOURCE_MAXIMUMS.requestsPerChannelPerHour);
      if (!withinQuota) {
        const retryAfter = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
        throw new ApiSourceFetchError(
          "rate_limited",
          "API source channel quota reached.",
          new Date(now).toISOString(),
          undefined,
          retryAfter,
        );
      }
    }
    let response: Response;
    try {
      response = await fetcher(current.href, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": API_SOURCE_USER_AGENT,
        },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal,
        ...(disableEdgeCache ? { cache: "no-store", cf: { cacheTtl: 0, cacheEverything: false } } : {}),
      });
    } catch (failure: unknown) {
      const timedOut = failure instanceof Error && (failure.name === "TimeoutError" || failure.name === "AbortError");
      throw new ApiSourceFetchError(
        timedOut ? "timeout" : "unreachable",
        timedOut ? "API source request timed out." : "API source endpoint could not be reached.",
        new Date(now).toISOString(),
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        await cancelBody(response);
        throw new ApiSourceFetchError("http_error", `API source returned HTTP ${String(response.status)}.`, new Date(now).toISOString(), response.status);
      }
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/u.test(contentType)) {
        await cancelBody(response);
        throw new ApiSourceFetchError("invalid_json", "API source did not return JSON.", new Date(now).toISOString(), response.status);
      }
      let body: { value: unknown; bytes: number };
      try {
        body = await readBoundedJsonResponseWithBytes(response, API_SOURCE_RESPONSE_MAXIMUM_BYTES);
      } catch (failure: unknown) {
        const message = failure instanceof Error ? failure.message : "";
        const timedOut = failure instanceof Error && (failure.name === "TimeoutError" || failure.name === "AbortError");
        const reason: ApiSourceFailureReason = message.includes("exceeded the size limit")
          ? "response_too_large"
          : failure instanceof SyntaxError || message.includes("had no body") ? "invalid_json"
            : timedOut ? "timeout" : "unreachable";
        throw new ApiSourceFetchError(
          reason,
          message || "API source response could not be read.",
          new Date(now).toISOString(),
          response.status,
        );
      }
      return {
        payload: body.value,
        httpStatus: response.status,
        bytes: body.bytes,
        fetchedAt: new Date(now).toISOString(),
        expiresAt: cacheExpiry(response.headers, now),
      };
    }
    const location = response.headers.get("Location");
    await cancelBody(response);
    if (location === null || redirects >= API_SOURCE_MAXIMUM_REDIRECTS) {
      throw new ApiSourceFetchError("redirect_error", "API source redirect limit reached.", new Date(now).toISOString(), response.status);
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ApiSourceFetchError("redirect_error", "API source returned an invalid redirect.", new Date(now).toISOString(), response.status);
    }
    try {
      validateApiSourceUrl(next.href, ownOrigin);
    } catch {
      throw new ApiSourceFetchError("redirect_error", "API source URL is not allowed.", new Date(now).toISOString(), response.status);
    }
    current = next;
    redirects += 1;
  }
};

export const fetchCachedApiSourceResult = async (
  db: D1Database,
  channelId: string,
  url: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<CachedApiSourceJsonResponse> => {
  const canonicalUrl = validateApiSourceUrl(url, ownOrigin).href;
  const urlHash = await cacheHash(channelId, canonicalUrl);
  const cached = await readCachedApiPayload(db, urlHash, now);
  if (cached !== null) {
    return { payload: cached.payload, httpStatus: null, bytes: null, fetchedAt: null, expiresAt: null };
  }

  const parsedUrl = validateApiSourceUrl(canonicalUrl, ownOrigin);
  // The outbound adapter deliberately has no way to set authorization, cookies,
  // arbitrary headers, a method, or a request body.
  const result = await requestJson(db, channelId, parsedUrl.href, ownOrigin, now, externalFetchBudget, fetcher, true);
  if (result.expiresAt !== null) await storeCachedApiPayload(db, channelId, urlHash, result.payload, result.expiresAt, now);
  return result;
};

export const fetchCachedApiSourceJson = async (
  db: D1Database,
  channelId: string,
  url: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<unknown> => (await fetchCachedApiSourceResult(db, channelId, url, ownOrigin, now, externalFetchBudget, fetcher)).payload;

export const fetchUncachedApiSourceJson = async (
  db: D1Database,
  channelId: string,
  url: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<ApiSourceJsonResponse> => requestJson(db, channelId, url, ownOrigin, now, externalFetchBudget, fetcher, true, true);

export const readCachedApiSourceJson = async (
  db: D1Database,
  channelId: string,
  url: string,
  ownOrigin: string | undefined,
  now: number,
): Promise<unknown> => {
  const canonicalUrl = validateApiSourceUrl(url, ownOrigin).href;
  const cached = await readCachedApiPayload(db, await cacheHash(channelId, canonicalUrl), now);
  return cached?.payload ?? null;
};
