import type { ModuleChatStatus } from "../contract";
import type {
  TEXT_COMMAND_FOLLOWAGE_VARIABLES,
  TEXT_COMMAND_GAME_VARIABLES,
  TEXT_COMMAND_SHOUTOUT_VARIABLES,
  TEXT_COMMAND_UPTIME_VARIABLES,
  TEXT_COMMAND_VARIABLES,
  TextCommandMinimumTier,
} from "../contracts";
import { renderTemplate, type TemplateValues } from "../contract";

export const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type TextCommandInput =
  | { kind: "command"; name: string; arguments?: string }
  | { kind: "unknown" };

export const validCommandName = (name: string): boolean => COMMAND_NAME_PATTERN.test(name);

export const commandFromMessage = (message: string): TextCommandInput | null => {
  const trimmed = message.trim();
  const firstWord = trimmed.split(/\s+/u)[0];
  if (firstWord === undefined || !firstWord.startsWith("!")) return null;
  const name = firstWord.slice(1).toLowerCase();
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

export type TemplateLanguage = "de" | "en";

export const renderUptimeText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_UPTIME_VARIABLES>,
): string => renderTemplate(text, values);

export const renderOfflineText = (
  text: string,
  values: TemplateValues<readonly [typeof TEXT_COMMAND_VARIABLES[1]]>,
): string => renderTemplate(text, values);

export const renderFollowageText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_FOLLOWAGE_VARIABLES>,
): string => renderTemplate(text, values);

export const renderNotFollowingText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_VARIABLES>,
): string => renderTemplate(text, values);

export const renderUnavailableText = (text: string): string => renderTemplate(text, {});

export const renderGameText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_GAME_VARIABLES>,
): string => renderTemplate(text, values);

export const renderShoutoutText = (
  text: string,
  values: TemplateValues<typeof TEXT_COMMAND_SHOUTOUT_VARIABLES>,
): string => renderTemplate(text, values);

const nonNegativeDate = (value: string): Date | null => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
};

export const formatUptime = (startedAt: string, now: string, language: TemplateLanguage): string => {
  const start = Date.parse(startedAt);
  const end = Date.parse(now);
  const elapsedMinutes = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 60_000))
    : 0;
  const days = Math.floor(elapsedMinutes / 1440);
  const hours = Math.floor((elapsedMinutes % 1440) / 60);
  const minutes = elapsedMinutes % 60;
  if (language === "de") {
    return `${days > 0 ? `${String(days)} Tg. ` : ""}${String(hours)} Std. ${String(minutes)} Min.`;
  }
  return `${days > 0 ? `${String(days)} d ` : ""}${String(hours)} h ${String(minutes)} min`;
};

export const formatFollowage = (followedAt: string, now: string, language: TemplateLanguage): string => {
  const start = nonNegativeDate(followedAt);
  const end = nonNegativeDate(now);
  if (start === null || end === null || start.getTime() > end.getTime()) {
    return language === "de" ? "0 Monate" : "0 months";
  }
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate() || (
    end.getUTCDate() === start.getUTCDate() &&
    (end.getUTCHours() < start.getUTCHours() || (
      end.getUTCHours() === start.getUTCHours() &&
      (end.getUTCMinutes() < start.getUTCMinutes() || (
        end.getUTCMinutes() === start.getUTCMinutes() && end.getUTCSeconds() < start.getUTCSeconds()
      ))
    ))
  )) months = Math.max(0, months - 1);
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (language === "de") {
    const parts = [
      ...(years === 0 ? [] : [`${String(years)} ${years === 1 ? "Jahr" : "Jahre"}`]),
      ...(remainingMonths === 0 ? [] : [`${String(remainingMonths)} ${remainingMonths === 1 ? "Monat" : "Monate"}`]),
    ];
    return parts.length === 0 ? "weniger als 1 Monat" : parts.join(", ");
  }
  const parts = [
    ...(years === 0 ? [] : [`${String(years)} ${years === 1 ? "year" : "years"}`]),
    ...(remainingMonths === 0 ? [] : [`${String(remainingMonths)} ${remainingMonths === 1 ? "month" : "months"}`]),
  ];
  return parts.length === 0 ? "less than 1 month" : parts.join(", ");
};

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
export const statusForTier: Record<TextCommandMinimumTier, readonly ModuleChatStatus[]> = {
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
