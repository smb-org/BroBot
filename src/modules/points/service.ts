import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage, ModuleResult } from "../contract";
import type { PointsSettings } from "./contracts";
import { pointsCatalog } from "./locale";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const textValue = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

const messageText = (event: ModuleEvent): string | null => {
  const message = record(event.payload.message);
  return typeof message?.text === "string" ? message.text.trim() : null;
};

const monthKey = (timestamp: string): string => new Date(timestamp).toISOString().slice(0, 7);

export const localizedMonth = (month: string, language: ModuleLanguage): string => {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(date);
};

export const pointsBalanceReply = (args: {
  balance: number;
  currency: string;
  monthNet: number;
  rank: number | null;
  language: ModuleLanguage;
}): string => {
  const format = new Intl.NumberFormat(args.language === "de" ? "de-DE" : "en-US");
  const net = `${args.monthNet >= 0 ? "+" : ""}${format.format(args.monthNet)}`;
  return pointsCatalog[args.language].chat.balance(format.format(args.balance), args.currency, net, args.rank);
};

export const pointsTopReply = (args: {
  month: string;
  entries: readonly { login: string; net: number }[];
  currency: string;
  language: ModuleLanguage;
}): string => pointsCatalog[args.language].chat.top(localizedMonth(args.month, args.language), args.entries, args.currency);

const enabledGames = async (channelId: string, context: ModuleExecutionContext, language: ModuleLanguage): Promise<string[]> => {
  const modules = await import("../registry");
  const rows = await context.DB.prepare("SELECT module_id FROM channel_modules WHERE channel_id = ? AND enabled = 1")
    .bind(channelId).all<{ module_id: string }>();
  const enabled = new Set(rows.results.map(({ module_id }) => module_id));
  return modules.MODULES.flatMap((module) => {
    if (!module.requiresModules?.includes("points") || !enabled.has(module.id)) return [];
    const entry = module.navigationEntries?.[0];
    if (module.id === "emote_slots") return [`${entry?.label[language] ?? "Slot"} !slot`];
    if (module.id === "blitz_round") return [pointsCatalog[language].chat.blitzGame];
    return [entry?.label[language] ?? module.id];
  });
};

export const processPointsMessage = async (
  event: ModuleEvent<PointsSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const userId = event.payload.chatter_user_id;
  const login = event.payload.chatter_user_login;
  const text = messageText(event);
  if (typeof userId !== "string" || typeof login !== "string" || text === null) return { actions: [], diagnostics: [] };
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterUserId = event.payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterUserId === "string" && sourceBroadcasterUserId !== event.channelId) return { actions: [], diagnostics: [] };

  const timestamp = Date.parse(event.eventSubTimestamp ?? event.receivedAt);
  const messageAt = Number.isFinite(timestamp) ? timestamp : Date.now();
  const language = await context.channelLanguage();
  const accountId = userId;
  let welcomePending = event.pointChatPrepared?.welcomePending ?? false;
  if (event.pointChatPrepared === undefined) {
    const welcome = await context.points.touchAccount(accountId, login, event.settings.startBonus);
    welcomePending = welcome.welcomePending;
    const live = await context.streamState();
    await context.points.creditActivity(accountId, login, messageAt, live === "online", {
      amount: event.settings.activityAmount,
      windowMinutes: event.settings.windowMinutes,
      dailyCap: event.settings.dailyCap,
    });
  }

  const command = text.toLowerCase().split(/\s+/u, 1)[0];
  let reply: string | null = null;
  const currentMonth = monthKey(new Date().toISOString());
  if (command === "!punkte") {
    const [balance, rank] = await Promise.all([
      context.points.balance(accountId),
      context.points.rankOf(accountId, currentMonth),
    ]);
    reply = pointsBalanceReply({ balance, currency: event.settings.currencyName, monthNet: rank.net, rank: rank.rank, language });
  } else if (command === "!top") {
    const entries = await context.points.ranking(currentMonth, 3);
    reply = pointsTopReply({ month: currentMonth, entries, currency: event.settings.currencyName, language });
  } else if (command === "!spiele") {
    const games = await enabledGames(event.channelId, context, language);
    const catalog = pointsCatalog[language].chat;
    const pendingNote = event.pointChatPrepared === undefined
      ? await context.points.getPendingWelcome?.(accountId)
      : event.pointChatPrepared.pendingWelcome;
    const startBonusPending = pendingNote === undefined
      ? welcomePending
      : pendingNote?.kind === "start_bonus" || pendingNote === null && welcomePending;
    reply = `${catalog.games(games)}${startBonusPending ? "" : ` · ${catalog.startBonus(event.settings.startBonus, event.settings.currencyName)}`} · !punkte`;
  }

  const messageId = textValue(event.payload.message_id);
  return {
    actions: reply === null ? [] : [{
      kind: "chat",
      text: reply,
      automated: false,
      ...(messageId === null ? {} : { replyToMessageId: messageId }),
    }],
    diagnostics: [],
  };
};
