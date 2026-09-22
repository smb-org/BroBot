import type { ModuleChatStatus } from "../contract";
import type { TextCommandMinimumTier } from "../contracts";

export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextCommandInput =
  | { kind: "befehl"; name: string; argumente?: string }
  | { kind: "unbekannt" };

export const validCommandName = (name: string): boolean => COMMAND_NAME_PATTERN.test(name);

export const commandFromMessage = (message: string): TextCommandInput | null => {
  const trimmed = message.trim();
  const erstesWort = trimmed.split(/\s+/u)[0];
  if (erstesWort === undefined || !erstesWort.startsWith("!")) return null;
  const name = erstesWort.slice(1);
  if (!validCommandName(name)) return { kind: "unbekannt" };
  const argumente = trimmed.slice(erstesWort.length).trim();
  return {
    kind: "befehl",
    name,
    ...(argumente.length === 0 ? {} : { argumente }),
  };
};

export const commandTextWithPlaceholders = (text: string, user: string, channel: string): string =>
  text.replaceAll("{user}", user).replaceAll("{channel}", channel);

export const cooldownRestzeit = (zuletztVerwendet: string | null, jetzt: string, cooldownSeconds: number): number => {
  if (zuletztVerwendet === null) return 0;
  const vergangen = Date.parse(jetzt) - Date.parse(zuletztVerwendet);
  if (!Number.isFinite(vergangen) || vergangen < 0) return cooldownSeconds;
  return Math.max(0, Math.ceil(cooldownSeconds - vergangen / 1000));
};

/**
 * Die Stufen sind absichtlich keine Zahlenleiter. Die Statusliste kann mehrere
 * Badges enthalten: Moderator und Broadcaster erfüllen auch „Abonnent“ und
 * „VIP“, ein VIP aber nicht „Abonnent“.
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
