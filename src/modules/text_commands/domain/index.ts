import type { ModuleChatStatus } from "../contract";
import type { TEXT_COMMAND_VARIABLES, TextCommandMinimumTier } from "../contracts";
import { renderTemplate } from "../contract";
import type { TemplateValues } from "../contract";

export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextCommandInput =
  | { kind: "command"; name: string; arguments?: string }
  | { kind: "unknown" };

export const validCommandName = (name: string): boolean => COMMAND_NAME_PATTERN.test(name);

export const commandFromMessage = (message: string): TextCommandInput | null => {
  const trimmed = message.trim();
  const firstWord = trimmed.split(/\s+/u)[0];
  if (firstWord === undefined || !firstWord.startsWith("!")) return null;
  const name = firstWord.slice(1);
  if (!validCommandName(name)) return { kind: "unknown" };
  // Spelled out rather than shorthand: the key travels into
  // `event_log.detail_json`, so renaming the local would rename the stored key
  // with it. That is exactly how this broke once already.
  const commandArguments = trimmed.slice(firstWord.length).trim();
  return {
    kind: "command",
    name,
    ...(commandArguments.length === 0 ? {} : { arguments: commandArguments }),
  };
};

export const renderCommandText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_VARIABLES>,
): string => renderTemplate(text, values);

export const cooldownRemaining = (lastUsedAt: string | null, now: string, cooldownSeconds: number): number => {
  if (lastUsedAt === null) return 0;
  const elapsed = Date.parse(now) - Date.parse(lastUsedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return cooldownSeconds;
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed / 1000));
};

/**
 * The tiers are deliberately not a numeric ladder. The status list can
 * contain multiple badges: moderator and broadcaster also satisfy
 * "subscriber" and "VIP", but a VIP does not satisfy "subscriber".
 */
const statusForTier: Record<TextCommandMinimumTier, readonly ModuleChatStatus[]> = {
  everyone: ["viewer", "subscriber", "vip", "moderator", "broadcaster"],
  subscriber: ["subscriber", "moderator", "broadcaster"],
  vip: ["vip", "moderator", "broadcaster"],
  moderator: ["moderator", "broadcaster"],
  broadcaster: ["broadcaster"],
};

export const chatStatusMeetsTier = (
  status: readonly ModuleChatStatus[] | null,
  minimumTier: TextCommandMinimumTier,
): boolean => minimumTier === "everyone"
  || (status !== null && status.some((entry) => statusForTier[minimumTier].includes(entry)));
