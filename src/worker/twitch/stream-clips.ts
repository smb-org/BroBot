import type { ModuleExternalFetchBudget, ModuleStreamClip } from "../../modules/contract";
import { getAppAccessToken, readCachedAppAccessToken } from "../app-token";
import { helixRequest } from "./helix";

const CLIPS_PER_PAGE = 100;
const MAX_CLIP_PAGES = 5;

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const mayFetch = (budget: ModuleExternalFetchBudget | undefined): boolean => budget?.claim() ?? true;

const readClip = (value: unknown): ModuleStreamClip | null => {
  const clip = recordValue(value);
  if (clip === null || typeof clip.id !== "string" || clip.id.length === 0 ||
      typeof clip.title !== "string" || typeof clip.created_at !== "string" ||
      !Number.isFinite(Date.parse(clip.created_at))) return null;

  const result: ModuleStreamClip = {
    clipId: clip.id,
    title: clip.title,
    createdAt: clip.created_at,
  };
  if (typeof clip.view_count === "number" && Number.isSafeInteger(clip.view_count) && clip.view_count >= 0) {
    result.viewCount = clip.view_count;
  }
  if (typeof clip.duration === "number" && Number.isFinite(clip.duration) && clip.duration >= 0) {
    result.durationSeconds = clip.duration;
  }
  return result;
};

/** Reads at most 500 clips for a stream, returning only fields approved for its long-lived timeline. */
export const fetchStreamClips = async (
  environment: Env,
  broadcasterId: string,
  startedAt: string,
  endedAt: string,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<readonly ModuleStreamClip[] | null> => {
  try {
    const now = new Date().toISOString();
    let accessToken = await readCachedAppAccessToken(environment.DB, environment, now);
    if (accessToken === null) {
      if (!mayFetch(externalFetchBudget)) return null;
      accessToken = await getAppAccessToken(environment, now, fetcher);
    }

    const clips: ModuleStreamClip[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_CLIP_PAGES; pageIndex += 1) {
      if (!mayFetch(externalFetchBudget)) return null;
      const result = await helixRequest<{ data?: unknown; pagination?: unknown }>({
        url: "https://api.twitch.tv/helix/clips",
        clientId: environment.TWITCH_CLIENT_ID,
        accessToken,
        fetcher,
        query: {
          broadcaster_id: broadcasterId,
          started_at: startedAt,
          ended_at: endedAt,
          first: String(CLIPS_PER_PAGE),
          after: cursor,
        },
      });
      if (!result.ok) return null;
      const body = recordValue(result.data);
      if (body === null || !Array.isArray(body.data)) return null;
      for (const rawClip of body.data.slice(0, CLIPS_PER_PAGE)) {
        const clip = readClip(rawClip);
        if (clip === null) return null;
        clips.push(clip);
      }

      const nextCursor = recordValue(body.pagination)?.cursor;
      if (typeof nextCursor !== "string" || nextCursor.length === 0) return clips;
      if (seenCursors.has(nextCursor)) return null;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return clips;
  } catch {
    return null;
  }
};
