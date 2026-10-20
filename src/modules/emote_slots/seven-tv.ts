import { parseSevenTvActiveSet, type SevenTvSlotEmote } from "./domain/seven-tv";

export type SevenTvEmoteResponse = {
  status: "ok" | "no_account" | "unavailable";
  setName: string | null;
  items: SevenTvSlotEmote[];
};

const SEVEN_TV_CACHE_TTL_MS = 10 * 60_000;
const SEVEN_TV_TIMEOUT_MS = 1_800;
const sevenTvCache = new Map<string, { expiresAt: number; value: SevenTvEmoteResponse }>();

const emptyResponse = (status: "no_account" | "unavailable"): SevenTvEmoteResponse => ({
  status,
  setName: null,
  items: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Best-effort lookup shared by the picker and booked spin presentation. */
export const fetchSevenTvEmotes = async (
  twitchUserId: string,
  fetcher: typeof fetch = fetch,
): Promise<SevenTvEmoteResponse> => {
  const cached = sevenTvCache.get(twitchUserId);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;

  const fetchedAt = Date.now();
  let value: SevenTvEmoteResponse;
  try {
    const response = await fetcher(`https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchUserId)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(SEVEN_TV_TIMEOUT_MS),
    });
    if (response.status === 404) {
      value = emptyResponse("no_account");
    } else if (!response.ok) {
      value = emptyResponse("unavailable");
    } else {
      const contentLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
        value = emptyResponse("unavailable");
      } else {
        const body = await response.text();
        if (new TextEncoder().encode(body).byteLength > 1_000_000) {
          value = emptyResponse("unavailable");
        } else {
          let parsed: unknown;
          try { parsed = JSON.parse(body) as unknown; } catch { parsed = null; }
          if (!isRecord(parsed)) {
            value = emptyResponse("unavailable");
          } else if (Object.hasOwn(parsed, "emote_set") && parsed.emote_set === null) {
            value = emptyResponse("no_account");
          } else {
            const activeSet = parseSevenTvActiveSet(parsed);
            value = activeSet === null
              ? emptyResponse("unavailable")
              : { status: "ok", setName: activeSet.setName, items: activeSet.items };
          }
        }
      }
    }
  } catch {
    value = emptyResponse("unavailable");
  }

  if (value.status !== "unavailable") {
    sevenTvCache.set(twitchUserId, { expiresAt: fetchedAt + SEVEN_TV_CACHE_TTL_MS, value });
  }
  return value;
};

export const clearSevenTvEmoteCache = (twitchUserId?: string): void => {
  if (twitchUserId === undefined) sevenTvCache.clear();
  else sevenTvCache.delete(twitchUserId);
};
