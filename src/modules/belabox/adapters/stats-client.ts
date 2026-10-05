import type { ModuleExternalFetchBudget } from "../../contract";
import { readBoundedJsonResponse } from "../../contract";
import { BELABOX_STATS_RESPONSE_MAX_BYTES, BELABOX_STATS_TIMEOUT_MS, type BelaboxFetchResult } from "../contracts";
import { parseRelayStats } from "../domain/stats";

const isTimeout = (error: unknown): boolean => {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return false;
  try {
    return "name" in error && (error.name === "TimeoutError" || error.name === "AbortError");
  } catch {
    return false;
  }
};

const isTooLarge = (error: unknown): boolean =>
  error instanceof Error && error.message === "JSON response exceeded the size limit.";

/** Fetches and normalizes one relay response without exposing transport errors. */
export const fetchRelaySample = async (
  url: URL,
  publisherKey: string,
  budget: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<BelaboxFetchResult> => {
  try {
    if (!budget.claim()) return { ok: false, reason: "budget_exhausted" };
    const response = await fetcher(url.href, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "BroBot/0.1.0" },
      signal: AbortSignal.timeout(BELABOX_STATS_TIMEOUT_MS),
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: "redirect_rejected" };
    if (response.status >= 500) return { ok: false, reason: "http_5xx" };
    if (response.status >= 400) return { ok: false, reason: "http_4xx" };

    let payload: unknown;
    try {
      payload = await readBoundedJsonResponse(response, BELABOX_STATS_RESPONSE_MAX_BYTES);
    } catch (error: unknown) {
      if (isTimeout(error)) return { ok: false, reason: "timeout" };
      return { ok: false, reason: isTooLarge(error) ? "too_large" : "malformed" };
    }

    try {
      return {
        ok: true,
        sample: { at: new Date().toISOString(), ...parseRelayStats(payload, publisherKey) },
      };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } catch (error: unknown) {
    return { ok: false, reason: isTimeout(error) ? "timeout" : "network" };
  }
};
