import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { hasCommandPrefix, selectFaqMatch } from "./domain";
import type { FaqSelection } from "./domain";
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
  gameId: string | null,
): Promise<FaqSelection> => selectFaqMatch(await repository.matchers(channelId), message, gameId);

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
  // Cheap keyword scan first, with no game resolved: a hit against an
  // unrestricted entry needs no Helix lookup at all, and a total miss rules
  // the message out without any I/O. Only a keyword hit against a
  // game-bound entry (recorded in skippedByGame) needs the current game.
  const withoutGame = selectFaqMatch(prepared, text, null);
  // Any game-bound entry skipped before this result was decided (whether it
  // ended in a match or not) might turn eligible once the real game is
  // known, and -- being earlier in order -- would then win over it. Only a
  // clean, unskipped result (an unrestricted match, or no keyword hit at
  // all) can be trusted without resolving the game.
  const selection = withoutGame.skippedByGame.length === 0
    ? withoutGame
    : selectFaqMatch(prepared, text, await (context.channelGameId ?? (() => Promise.resolve(null)))());
  const match = selection.match;
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
