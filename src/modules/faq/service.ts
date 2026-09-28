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

  const result = await testFaqMessage(repository, event.channelId, text);
  const match = result.match;
  if (match === null) return { actions: [], diagnostics: [] };
  if (match.entry.games.length > 0) {
    const currentGameId = await (context.channelGameId ?? (() => Promise.resolve(null)))();
    if (currentGameId !== null && !match.entry.games.some((game) => game.id === currentGameId)) {
      return { actions: [], diagnostics: [] };
    }
  }

  const claim = await repository.claim(event.channelId, match.entry, event.receivedAt);
  if (!claim.claimed) return { actions: [], diagnostics: [] };
  const rendered = await context.renderTemplate(`{${match.entry.answerBlock}}`, {});
  return {
    actions: rendered.text.length === 0 ? [] : [{ kind: "chat", text: rendered.text, target: match.entry.chatTarget }],
    diagnostics: rendered.diagnostics,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
  };
};
