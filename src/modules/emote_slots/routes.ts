import { Hono, type Context } from "hono";

import type { ModuleRouteEnvironment, ModuleTwitchEmote } from "../contract";
import { fetchSevenTvEmotes, clearSevenTvEmoteCache } from "./seven-tv";
import type { SevenTvEmoteResponse } from "./seven-tv";

type SlotContext = Context<ModuleRouteEnvironment>;
type SlotEmote = { source: "emoji" | "twitch" | "seven_tv"; code: string; twitchId?: string; sevenTvId?: string; name: string; imageUrl?: string };
type EmoteResponse = {
  emoji: { items: SlotEmote[] };
  twitch: { status: "ok" | "reconnect_required" | "unavailable"; items: SlotEmote[] };
  sevenTv: SevenTvEmoteResponse;
};
type TwitchEmoteGroup = EmoteResponse["twitch"];

const emojiItems: SlotEmote[] = [
  { source: "emoji", code: "🍒", name: "Cherry" },
  { source: "emoji", code: "🍋", name: "Lemon" },
  { source: "emoji", code: "🔔", name: "Bell" },
  { source: "emoji", code: "⭐", name: "Star" },
  { source: "emoji", code: "💎", name: "Diamond" },
  { source: "emoji", code: "7️⃣", name: "Seven" },
  { source: "emoji", code: "💀", name: "Skull" },
  { source: "emoji", code: "🔥", name: "Fire" },
  { source: "emoji", code: "🍀", name: "Clover" },
  { source: "emoji", code: "🎰", name: "Slot machine" },
  { source: "emoji", code: "👑", name: "Crown" },
  { source: "emoji", code: "❤️", name: "Heart" },
];

const twitchEmoteCache = new Map<string, { expiresAt: number; value: TwitchEmoteGroup }>();

const moduleContext = (context: SlotContext): { channelId: string; clientId: string } => ({
  channelId: context.req.param("channelId") ?? "",
  clientId: context.env.TWITCH_CLIENT_ID,
});

const slotEmote = (emote: ModuleTwitchEmote): SlotEmote => ({
  source: "twitch",
  code: emote.name,
  twitchId: emote.id,
  name: emote.name,
  ...(emote.images?.url_1x === undefined ? {} : { imageUrl: emote.images.url_1x }),
});

const listEmotes = async (context: SlotContext): Promise<EmoteResponse> => {
  const { channelId, clientId } = moduleContext(context);
  const cachedTwitch = twitchEmoteCache.get(channelId);
  const sevenTvPromise = fetchSevenTvEmotes(channelId);
  if (cachedTwitch !== undefined && cachedTwitch.expiresAt > Date.now()) {
    return {
      emoji: { items: emojiItems },
      twitch: cachedTwitch.value,
      sevenTv: await sevenTvPromise,
    };
  }
  const [credentials, appToken, sevenTv] = await Promise.all([
    (context.get("botCredentials")?.(channelId) ?? Promise.resolve(null)).catch(() => null),
    context.get("getAppAccessToken")(context.env, new Date().toISOString()).catch(() => null),
    sevenTvPromise,
  ]);
  const global = appToken === null ? null : await context.get("getGlobalEmotes")({ clientId, accessToken: appToken }).catch(() => null);
  const twitchItems = new Map<string, SlotEmote>();
  if (global?.ok === true) for (const emote of global.data) twitchItems.set(emote.id, slotEmote(emote));
  let status: EmoteResponse["twitch"]["status"] = "ok";
  const scopes = credentials?.scopes ?? [];
  if (credentials === null || !scopes.includes("user:read:emotes")) {
    status = "reconnect_required";
  } else {
    const userEmotes = await context.get("getUserEmotes")({
      clientId,
      accessToken: credentials.accessToken,
      userId: credentials.userId,
      broadcasterId: channelId,
    }).catch(() => null);
    if (userEmotes?.ok === false || userEmotes === null || global?.ok === false || global === null) status = "unavailable";
    if (userEmotes?.ok) for (const emote of userEmotes.data) twitchItems.set(emote.id, slotEmote(emote));
  }
  const value: EmoteResponse = {
    emoji: { items: emojiItems },
    twitch: { status, items: [...twitchItems.values()] },
    sevenTv,
  };
  if (status === "ok") twitchEmoteCache.set(channelId, {
    expiresAt: Date.now() + 10 * 60_000,
    value: value.twitch,
  });
  return value;
};

export const clearEmoteSlotEmoteCache = (channelId?: string): void => {
  if (channelId === undefined) twitchEmoteCache.clear();
  else twitchEmoteCache.delete(channelId);
  clearSevenTvEmoteCache(channelId);
};

export const emoteSlotsRoutes = new Hono<ModuleRouteEnvironment>();

emoteSlotsRoutes.get("/emotes", async (context) => {
  try {
    return context.json(await listEmotes(context));
  } catch {
    return context.json({
      emoji: { items: emojiItems },
      twitch: { status: "unavailable", items: [] },
      sevenTv: { status: "unavailable", setName: null, items: [] },
    } satisfies EmoteResponse);
  }
});

