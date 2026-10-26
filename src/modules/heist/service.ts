import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { HEIST_COMMAND, HEIST_MODULE_ID, type HeistRoundData, type HeistSettings } from "./contracts";
import { parseHeistCommand } from "./domain/command";
import { heistRoundIdForMessage } from "./domain/round-id";
import { heistCatalog } from "./locale";

const emptyResult: ModuleResult = { actions: [], diagnostics: [] };
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

type HeistErrorKey = keyof typeof heistCatalog.en.errors;

const errorText = (key: HeistErrorKey, language: "de" | "en", settings: HeistSettings): string => {
  const messages = heistCatalog[language].errors;
  if (key === "stakeBounds") return messages.stakeBounds(settings.minStake, settings.maxStake);
  return messages[key];
};

const errorReply = async (
  context: ModuleExecutionContext,
  settings: HeistSettings,
  language: "de" | "en",
  accountId: string,
  messageId: string,
  key: HeistErrorKey,
): Promise<ModuleResult> => {
  if (!await context.points.claimCooldown(`error:${accountId}`, 60)) return emptyResult;
  return {
    actions: [{ kind: "chat", text: errorText(key, language, settings), replyToMessageId: messageId, automated: false }],
    diagnostics: [],
  };
};

const participantOperationId = (roundId: string, accountId: string): string =>
  `round:${roundId}:participant:${accountId}`;

export const processHeistMessage = async (
  event: ModuleEvent<HeistSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return emptyResult;
  const payload = event.payload;
  const userId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  const messageId = payload.message_id;
  const message = record(payload.message)?.text;
  if (typeof userId !== "string" || typeof login !== "string" || typeof messageId !== "string" || messageId.length === 0 ||
      typeof message !== "string") return emptyResult;
  if (await context.botUserId?.() === userId) return emptyResult;
  const sourceBroadcasterUserId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterUserId === "string" && sourceBroadcasterUserId !== event.channelId) return emptyResult;

  const parsed = parseHeistCommand(message, { command: HEIST_COMMAND, minStake: event.settings.minStake, maxStake: event.settings.maxStake });
  if (!parsed.ok) {
    if (parsed.reason === "not_command") return emptyResult;
    const language = await context.channelLanguage();
    return errorReply(context, event.settings, language, userId, messageId,
      parsed.reason === "out_of_range" ? "stakeBounds" : "invalidStake");
  }

  const active = await context.points.rounds.active();
  if (active?.state === "open") {
    try {
      await context.points.rounds.join(active.roundId, participantOperationId(active.roundId, userId), userId, login, parsed.stake, {});
    } catch (error) {
      if ((error instanceof Error ? error.message : "") === "insufficient_points") {
        return errorReply(context, event.settings, await context.channelLanguage(), userId, messageId, "insufficientPoints");
      }
    }
    // Heist intentionally has no per-join replies; the start and one final summary fit its line budget.
    return emptyResult;
  }
  if (active !== null) return emptyResult;

  const language = await context.channelLanguage();
  const roundId = await heistRoundIdForMessage(messageId);
  const startEnabled = isMessageEnabled(event.settings, "startText", "startTextEnabled");
  const resultEnabled = isMessageEnabled(event.settings, "resultText", "resultTextEnabled");
  const data: HeistRoundData & Record<string, unknown> = {
    language,
    joinWindowSeconds: event.settings.joinWindowSeconds,
    startMessageId: messageId,
    startText: event.settings.startText,
    startTextEnabled: startEnabled,
    resultText: event.settings.resultText,
    resultTextEnabled: resultEnabled,
    lockKeys: ["heist:active"],
    durationS: event.settings.joinWindowSeconds,
    announceText: startEnabled ? event.settings.startText : "",
    silentAnnouncement: !startEnabled,
    settlement: { kind: HEIST_MODULE_ID, params: { baseChance: event.settings.baseChance, maxChance: event.settings.maxChance } },
  };
  try {
    await context.points.rounds.openWithStake(
      roundId,
      data,
      participantOperationId(roundId, userId),
      userId,
      login,
      parsed.stake,
      { key: "between-rounds", seconds: event.settings.joinWindowSeconds + event.settings.cooldownSeconds },
    );
    return emptyResult;
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "insufficient_points") return errorReply(context, event.settings, language, userId, messageId, "insufficientPoints");
    if (code === "cooldown") return errorReply(context, event.settings, language, userId, messageId, "cooldown");
    if (code === "round_locked" || code === "round_active") return errorReply(context, event.settings, language, userId, messageId, "roundRunning");
    return emptyResult;
  }
};
