import type { ModuleExternalFetchBudget } from "../../modules/contract";
import { getAppAccessToken, readCachedAppAccessToken } from "../app-token";
import { botAccessTokenFor } from "./bot-access";
import { helixRequest } from "./helix";

const recordValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const mayFetch = (budget: ModuleExternalFetchBudget | undefined): boolean => budget?.claim() ?? true;

export const fetchLiveViewerCount = async (
  environment: Env,
  channelId: string,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<number | null> => {
  try {
    const now = new Date().toISOString();
    let accessToken = await readCachedAppAccessToken(environment.DB, environment, now);
    if (accessToken === null) {
      if (!mayFetch(externalFetchBudget)) return null;
      accessToken = await getAppAccessToken(environment, now, fetcher);
    }
    if (!mayFetch(externalFetchBudget)) return null;
    const result = await helixRequest<{ data?: unknown }>({
      url: "https://api.twitch.tv/helix/streams",
      query: { user_id: channelId, type: "live" },
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok) return null;
    const data = recordValue(result.data)?.data;
    if (!Array.isArray(data)) return null;
    const stream = recordValue(data[0]);
    const count = stream?.viewer_count;
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
};

export const fetchLiveChattersTotal = async (
  environment: Env,
  channelId: string,
  externalFetchBudget?: ModuleExternalFetchBudget,
  fetcher: typeof fetch = fetch,
): Promise<number | null> => {
  try {
    const bot = await botAccessTokenFor(environment);
    if (bot === null || !bot.scopes.includes("moderator:read:chatters") || !mayFetch(externalFetchBudget)) return null;
    const result = await helixRequest<{ total?: unknown }>({
      url: "https://api.twitch.tv/helix/chat/chatters",
      query: { broadcaster_id: channelId, moderator_id: bot.userId },
      accessToken: bot.accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok) return null;
    const total = recordValue(result.data)?.total;
    return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
};
