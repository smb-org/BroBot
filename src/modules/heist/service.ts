import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { HEIST_COMMAND, HEIST_COOLDOWN_KEY, HEIST_MODULE_ID, type HeistRoundData, type HeistSettings } from "./contracts";
import { parseHeistCommand } from "./domain/command";
import { heistRoundIdForMessage } from "./domain/round-id";
import { HEIST_CONFIRM_HANDLER, heistConfirmAlarmKey, heistConfirmLeadMs } from "./alarm";
import { heistCatalog } from "./locale";
import { record } from "./round-data";

const emptyResult: ModuleResult = { actions: [], diagnostics: [] };

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

/** Keyed on the chat message, so a redelivered message can never fund a later round a second time. */
const stakeOperationId = (messageId: string): string => `msg:${messageId}`;

/** Codes that are an ordinary outcome of a chat message; everything else surfaces as a module error. */
const IGNORED_CODES: ReadonlySet<string> = new Set(["operation_conflict"]);

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
      await context.points.rounds.join(active.roundId, stakeOperationId(messageId), userId, login, parsed.stake, {});
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code === "insufficient_points") {
        return errorReply(context, event.settings, await context.channelLanguage(), userId, messageId, "insufficientPoints");
      }
      if (!IGNORED_CODES.has(code)) throw error;
    }
    // No per-join replies: the start line, one batched midway line and the final summary make three lines per round.
    return emptyResult;
  }
  if (active !== null) return emptyResult;

  const language = await context.channelLanguage();
  const roundId = await heistRoundIdForMessage(messageId);
  const startEnabled = isMessageEnabled(event.settings, "startText", "startTextEnabled");
  const confirmEnabled = isMessageEnabled(event.settings, "confirmText", "confirmTextEnabled");
  const resultEnabled = isMessageEnabled(event.settings, "resultText", "resultTextEnabled");
  const data: HeistRoundData & Record<string, unknown> = {
    language,
    joinWindowSeconds: event.settings.joinWindowSeconds,
    startMessageId: messageId,
    startText: event.settings.startText,
    startTextEnabled: startEnabled,
    confirmText: event.settings.confirmText,
    confirmTextEnabled: confirmEnabled,
    resultText: event.settings.resultText,
    resultTextEnabled: resultEnabled,
    // The pause starts with the settlement itself, counted from the real end of the join window.
    cooldownAfter: { key: HEIST_COOLDOWN_KEY, seconds: event.settings.cooldownSeconds },
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
      stakeOperationId(messageId),
      userId,
      login,
      parsed.stake,
      // Zero seconds only checks the pause; the settlement starts it (see cooldownAfter above).
      { key: HEIST_COOLDOWN_KEY, seconds: 0 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "insufficient_points") return errorReply(context, event.settings, language, userId, messageId, "insufficientPoints");
    if (code === "cooldown") return errorReply(context, event.settings, language, userId, messageId, "cooldown");
    if (code === "round_locked" || code === "round_active") return errorReply(context, event.settings, language, userId, messageId, "roundRunning");
    if (!IGNORED_CODES.has(code)) throw error;
    return emptyResult;
  }
  // The join line is cosmetic: if its alarm cannot be scheduled this round simply has none. Stakes and the
  // result are unaffected, so the failure is only logged. The alarm corrects its time to the real middle
  // once the start line has been delivered.
  if (confirmEnabled) {
    try {
      await context.scheduleAlarm(HEIST_CONFIRM_HANDLER, heistConfirmAlarmKey(roundId),
        Date.now() + heistConfirmLeadMs(event.settings.joinWindowSeconds));
    } catch {
      return { actions: [], diagnostics: [{ code: "host.module.error", detail: { message: "heist_confirm_not_scheduled" } }] };
    }
  }
  return emptyResult;
};
