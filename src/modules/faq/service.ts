import { chatDeliveryReleasesClaim, type ModuleEvent, type ModuleExecutionContext, type ModuleResult } from "../contract";
import { hasCommandPrefix, selectFaqMatch } from "./domain";
import type { FaqRepository } from "./repository";

type FaqMessageContext = Pick<ModuleExecutionContext, "renderTemplate"> & Partial<Pick<
  ModuleExecutionContext,
  "botUserId" | "isRecentBotMessage" | "channelGameId"
>> & { readOnly?: boolean };

const messageText = (event: ModuleEvent): string | null => {
  const message = event.payload.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const text = (message as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
};

export const processFaqMessage = async (
  event: ModuleEvent,
  repository: FaqRepository,
  context: FaqMessageContext,
): Promise<ModuleResult> => {
  const text = messageText(event);
  if (event.subscriptionType !== "channel.chat.message" || text === null || text.length === 0) {
    return { actions: [], diagnostics: [] };
  }
  if (hasCommandPrefix(text)) return { actions: [], diagnostics: [] };
  const prepared = await repository.matchers(event.channelId);
  // Scan triggers first, with no game resolved: a hit against an unrestricted
  // entry needs no Helix lookup at all, and a total miss rules the message out
  // without any I/O. Only a trigger hit against a game-bound entry (recorded in
  // skippedByGame) needs the current game.
  const withoutGame = selectFaqMatch(prepared, text, null, event.chatStatus);
  // Any game-bound entry skipped before this result was decided (whether it
  // ended in a match or not) might turn eligible once the real game is
  // known, and -- being earlier in order -- would then win over it. Only a
  // clean, unskipped result (an unrestricted match, or no keyword hit at
  // all) can be trusted without resolving the game.
  const selection = withoutGame.skippedByGame.length === 0
    ? withoutGame
    : selectFaqMatch(prepared, text, await (context.channelGameId ?? (() => Promise.resolve(null)))(), event.chatStatus);
  const match = selection.match;
  if (match === null) return { actions: [], diagnostics: [] };

  const senderId = typeof event.payload.chatter_user_id === "string" ? event.payload.chatter_user_id : null;
  const botUserId = await context.botUserId?.() ?? null;
  if (botUserId === null || senderId === botUserId) return { actions: [], diagnostics: [] };
  if (await context.isRecentBotMessage?.(senderId, text)) return { actions: [], diagnostics: [] };

  let rendered: Awaited<ReturnType<typeof context.renderTemplate>>;
  let claimedAt: string;
  if (context.readOnly === true) {
    // Dry runs still sample answer blocks before simulating the cooldown claim
    // so later modules see the same deterministic text-block choices.
    rendered = await context.renderTemplate(match.entry.answerText, {});
    if (rendered.text.length === 0) return { actions: [], diagnostics: rendered.diagnostics };
    const claim = await repository.claim(event.channelId, match.entry, senderId, new Date().toISOString());
    if (!claim.claimed) return { actions: [], diagnostics: [] };
    claimedAt = claim.claimedAt;
  } else {
    const claim = await repository.claim(event.channelId, match.entry, senderId, new Date().toISOString());
    if (!claim.claimed) return { actions: [], diagnostics: [] };
    try {
      rendered = await context.renderTemplate(match.entry.answerText, {});
    } catch (error: unknown) {
      await repository.releaseClaim(event.channelId, match.entry, senderId, claim.claimedAt);
      throw error;
    }
    if (rendered.text.length === 0) {
      await repository.releaseClaim(event.channelId, match.entry, senderId, claim.claimedAt);
      return { actions: [], diagnostics: rendered.diagnostics };
    }
    claimedAt = claim.claimedAt;
  }
  return {
    actions: [{
      kind: "chat",
      text: rendered.text,
      ...(match.entry.chatTarget === null ? {} : { target: match.entry.chatTarget }),
      automated: true,
      onDelivery: async (delivery) => {
        if (chatDeliveryReleasesClaim(delivery)) {
          await repository.releaseClaim(event.channelId, match.entry, senderId, claimedAt);
        }
      },
    }],
    diagnostics: rendered.diagnostics,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
  };
};
