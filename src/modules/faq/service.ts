import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import type { FaqMatchResult } from "./contracts";
import { firstFaqMatch, hasCommandPrefix } from "./domain";
import type { FaqRepository } from "./repository";

const messageText = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
};

export const testFaqMessage = async (
  repository: FaqRepository,
  channelId: string,
  message: string,
): Promise<FaqMatchResult> => firstFaqMatch(await repository.matchers(channelId), message);

export const processFaqMessage = async (
  event: ModuleEvent,
  repository: FaqRepository,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (event.subscriptionType !== "channel.chat.message" || text === null || text.length === 0) {
    return { actions: [], diagnostics: [] };
  }
  if (hasCommandPrefix(text)) return { actions: [], diagnostics: [] };
  const senderId = typeof event.payload.chatter_user_id === "string" ? event.payload.chatter_user_id : null;
  const botUserId = await context.botUserId?.() ?? null;
  if (botUserId === null || senderId === botUserId) return { actions: [], diagnostics: [] };
  if (await context.isRecentBotMessage?.(senderId, text)) return { actions: [], diagnostics: [] };

  const prepared = await repository.matchers(event.channelId);
  const needsGame = prepared.some(({ entry }) => entry.games.length > 0);
  const currentGameId = needsGame
    ? await (context.channelGameId ?? (() => Promise.resolve(null)))()
    : null;
  const eligible = prepared.filter(({ entry }) => entry.games.length === 0 ||
    (currentGameId !== null && entry.games.some((game) => game.id === currentGameId)));
  const result = firstFaqMatch(eligible, text);
  const match = result.match;
  if (match === null) return { actions: [], diagnostics: [] };
  const rendered = await context.renderTemplate(`{${match.entry.answerBlock}}`, {});
  if (rendered.text.length === 0) return { actions: [], diagnostics: rendered.diagnostics };
  const claim = await repository.claim(event.channelId, match.entry, new Date().toISOString());
  if (!claim.claimed) return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "chat",
      text: rendered.text,
      target: match.entry.chatTarget,
      automated: true,
      onDelivery: async (delivery) => {
        if (delivery === "rejected" || delivery === "not_attempted") {
          await repository.releaseClaim(event.channelId, match.entry, claim.claimedAt);
        }
      },
    }],
    diagnostics: rendered.diagnostics,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
  };
};
