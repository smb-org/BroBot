import type { ModuleAlarmContext, ModuleAlarmDefinition } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { formatHeistNames } from "./locale";
import { heistRoundData, oneLine } from "./round-data";

export const HEIST_CONFIRM_HANDLER = "confirm";
const ALARM_KEY_PREFIX = "confirm:";
const NAME_LIMIT = 5;
const ANNOUNCEMENT_WAIT_MS = 5_000;

export const heistConfirmAlarmKey = (roundId: string): string => `${ALARM_KEY_PREFIX}${roundId}`;

/** Half of the join window, in milliseconds. */
export const heistConfirmLeadMs = (joinWindowSeconds: number): number => Math.floor(joinWindowSeconds / 2) * 1_000;

/**
 * Sends the one batched "who is in" line in the middle of the join window.
 * The chat send is claimed under a fixed key per round, so retries and restarts never repeat it.
 */
const handleConfirm = async (context: ModuleAlarmContext, alarmKey: string): Promise<void> => {
  const roundId = alarmKey.startsWith(ALARM_KEY_PREFIX) ? alarmKey.slice(ALARM_KEY_PREFIX.length) : "";
  const round = await context.points.rounds.active();
  if (roundId.length === 0 || round === null || round.roundId !== roundId) return;
  const data = heistRoundData(round.data);
  if (data === null || data.confirmText === undefined || !isMessageEnabled(data, "confirmText", "confirmTextEnabled")) return;
  // The window only starts once the start line is delivered, so wait for the real deadline.
  if (round.state !== "open" || round.deadlineAt === null) {
    await context.schedule(alarmKey, Date.now() + ANNOUNCEMENT_WAIT_MS);
    return;
  }
  const deadlineAt = round.deadlineAt;
  const dueAt = deadlineAt - heistConfirmLeadMs(data.joinWindowSeconds);
  if (Date.now() < dueAt) {
    await context.schedule(alarmKey, dueAt);
    return;
  }
  if (Date.now() >= deadlineAt) return;
  const joined = await context.points.rounds.participants(roundId, NAME_LIMIT);
  if (joined.count < 2) return;
  const rendered = await context.renderTemplate(data.confirmText, {
    "heist.count": joined.count,
    "heist.names": formatHeistNames(joined.logins, data.language, joined.count),
    "heist.pot": joined.totalStake,
  });
  const result = await context.sendChat(
    oneLine(rendered.text),
    `round:${roundId}:confirm`,
    rendered.attributions,
    async () => {
      const current = await context.points.rounds.active();
      return current?.roundId === roundId && current.state === "open" && Date.now() < deadlineAt;
    },
    undefined,
    { replyToMessageId: data.startMessageId, automated: false },
  );
  // A retryable failure (for example rate limiting) throws so the host retries with its backoff.
  if (result.retryable) throw new Error("heist_confirm_retry");
};

export const heistConfirmAlarm: ModuleAlarmDefinition = {
  key: HEIST_CONFIRM_HANDLER,
  retryDelaysMs: [2_000, 5_000, 10_000],
  handle: handleConfirm,
};
