import { readBoundedJsonResponse } from "../../contract";
import type { ModuleExternalFetchBudget } from "../../contract";
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
  db: D1Database,
  channelId: string,
  inputUrl: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget: ModuleExternalFetchBudget | undefined,
  fetcher: typeof fetch,
): Promise<{ payload: unknown; expiresAt: number | null }> => {
  const url = validateApiSourceUrl(inputUrl, ownOrigin);
  let current = url;
  let redirects = 0;
  const signal = AbortSignal.timeout(API_SOURCE_TIMEOUT_MS);
  for (;;) {
    validateApiSourceUrl(current.href, ownOrigin);
    if (externalFetchBudget !== undefined && !externalFetchBudget.claim()) {
      throw new Error("API source invocation request limit reached.");
    }
    const withinQuota = await claimApiSourceQuota(db, channelId, now, API_SOURCE_MAXIMUMS.requestsPerChannelPerHour);
    if (!withinQuota) throw new Error("API source channel quota reached.");
    const response = await fetcher(current.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": API_SOURCE_USER_AGENT,
      },
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (!response.ok) {
        await cancelBody(response);
        throw new Error(`API source returned HTTP ${String(response.status)}.`);
      }
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/u.test(contentType)) {
        await cancelBody(response);
        throw new Error("API source did not return JSON.");
      }
      return {
        payload: await readBoundedJsonResponse(response, API_SOURCE_RESPONSE_MAXIMUM_BYTES),
        expiresAt: cacheExpiry(response.headers, now),
      };
    }
    const location = response.headers.get("Location");
    await cancelBody(response);
    if (location === null || redirects >= API_SOURCE_MAXIMUM_REDIRECTS) {
      throw new Error("API source redirect limit reached.");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error("API source returned an invalid redirect.");
    }
    validateApiSourceUrl(next.href, ownOrigin);
    current = next;
    redirects += 1;
  }
};

export const fetchCachedApiSourceJson = async (
  db: D1Database,
  channelId: string,
  url: string,
  ownOrigin: string | undefined,
  now: number,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<unknown> => {
  const canonicalUrl = validateApiSourceUrl(url, ownOrigin).href;
  const urlHash = await cacheHash(channelId, canonicalUrl);
  const cached = await readCachedApiPayload(db, urlHash, now);
  if (cached !== null) return cached.payload;

  const parsedUrl = validateApiSourceUrl(canonicalUrl, ownOrigin);
  // The outbound adapter deliberately has no way to set authorization, cookies,
  // arbitrary headers, a method, or a request body.
  const result = await requestJson(db, channelId, parsedUrl.href, ownOrigin, now, externalFetchBudget, fetcher);
  if (result.expiresAt !== null) await storeCachedApiPayload(db, urlHash, result.payload, result.expiresAt, now);
  return result.payload;
};
