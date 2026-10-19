import { Hono, type Context } from "hono";

import type { ModuleRouteEnvironment, ModuleTwitchEmote } from "../contract";

type SlotContext = Context<ModuleRouteEnvironment>;
type SlotEmote = { source: "emoji" | "twitch"; code: string; twitchId?: string; name: string; imageUrl?: string };
type EmoteResponse = {
  emoji: { items: SlotEmote[] };
  twitch: { status: "ok" | "reconnect_required" | "unavailable"; items: SlotEmote[] };
};

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

const emoteCache = new Map<string, { expiresAt: number; value: EmoteResponse }>();

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
  const cached = emoteCache.get(channelId);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  const [credentials, appToken] = await Promise.all([
    (context.get("botCredentials")?.(channelId) ?? Promise.resolve(null)).catch(() => null),
    context.get("getAppAccessToken")(context.env, new Date().toISOString()).catch(() => null),
  ]);
  const global = appToken === null ? null : await context.get("getGlobalEmotes")({ clientId, accessToken: appToken }).catch(() => null);
  const twitchItems = new Map<string, SlotEmote>();
  if (global?.ok === true) for (const emote of global.data) twitchItems.set(emote.id, slotEmote(emote));
  let status: EmoteResponse["twitch"]["status"] = "ok";
  const scopes = credentials?.scopes ?? [];
  if (credentials === null || !scopes.includes("user:read:emotes")) {
    status = global?.ok === false || global === null ? "unavailable" : "reconnect_required";
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
  const value: EmoteResponse = { emoji: { items: emojiItems }, twitch: { status, items: [...twitchItems.values()] } };
  if (status !== "reconnect_required") emoteCache.set(channelId, { expiresAt: Date.now() + 10 * 60_000, value });
  return value;
};

export const clearEmoteSlotEmoteCache = (channelId?: string): void => {
  if (channelId === undefined) emoteCache.clear();
  else emoteCache.delete(channelId);
};

export const emoteSlotsRoutes = new Hono<ModuleRouteEnvironment>();

emoteSlotsRoutes.get("/emotes", async (context) => {
  try {
    return context.json(await listEmotes(context));
  } catch {
    return context.json({ emoji: { items: emojiItems }, twitch: { status: "unavailable", items: [] } } satisfies EmoteResponse);
  }
});

