import type { TextCommandKind, TextCommandResponseType, TextCommandVariableAction } from "../contracts";
import type { TextCommandMinimumTier } from "../contracts";

export const SLASH_COMMAND_NAMES = ["timeout", "announce", "shoutout"] as const;
export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

export type LeadingSlashCommand =
  | { status: "none" }
  | { status: "suggestions"; fragment: string }
  | { status: "unsupported" }
  | { status: "invalid"; command: SlashCommandName }
  | {
    status: "valid";
    command: SlashCommandName;
    bodyText: string;
    minSeconds?: number;
    maxSeconds?: number;
    reason?: string;
  };

const TIMEOUT_SECONDS_MAX = 1_209_600;

const isSlashCommandName = (value: string): value is SlashCommandName =>
  SLASH_COMMAND_NAMES.some((name) => name === value);

const isTimeoutDuration = (value: string): { minSeconds: number; maxSeconds: number } | null => {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value);
  if (match === null) return null;
  const minSeconds = Number(match[1]);
  const maxSeconds = Number(match[2] ?? match[1]);
  return Number.isSafeInteger(minSeconds) && Number.isSafeInteger(maxSeconds) &&
    minSeconds >= 1 && minSeconds <= maxSeconds && maxSeconds <= TIMEOUT_SECONDS_MAX
    ? { minSeconds, maxSeconds }
    : null;
};

export const parseLeadingSlashCommand = (text: string): LeadingSlashCommand => {
  if (!text.startsWith("/")) return { status: "none" };

  const token = /^\/([^\s]*)/u.exec(text)?.[1] ?? "";
  const command = token.toLowerCase();
  if (command.length === 0 || (SLASH_COMMAND_NAMES.some((name) => name.startsWith(command)) && !SLASH_COMMAND_NAMES.includes(command as SlashCommandName))) {
    return { status: "suggestions", fragment: command };
  }
  if (!isSlashCommandName(command)) return { status: "unsupported" };

  const firstLineEnd = text.search(/\r?\n/u);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const bodyText = firstLineEnd === -1 ? "" : text.slice(firstLineEnd).replace(/^\r?\n/u, "");

  if (command === "timeout") {
    const match = /^\/timeout[ \t]+\{user\}[ \t]+([^ \t]+)(?:[ \t]+(.*))?$/u.exec(firstLine);
    if (match === null) return { status: "invalid", command };
    const duration = isTimeoutDuration(match[1] ?? "");
    if (duration === null) return { status: "invalid", command };
    return {
      status: "valid",
      command,
      bodyText,
      ...duration,
      reason: match[2]?.trim() ?? "",
    };
  }

  if (command === "announce") {
    const match = /^\/announce[ \t]+([\s\S]+)$/u.exec(text);
    const announcement = match?.[1]?.trim();
    return announcement === undefined || announcement.length === 0
      ? { status: "invalid", command }
      : { status: "valid", command, bodyText: announcement };
  }

  const match = /^\/shoutout[ \t]+\{target\}[ \t]*$/u.exec(firstLine);
  return match === null
    ? { status: "invalid", command }
    : { status: "valid", command, bodyText };
};

export interface SlashConvertibleDraft {
  kind: TextCommandKind;
  text: string;
  responseType: TextCommandResponseType;
  variableAction: TextCommandVariableAction | null;
  timeoutAction: { minSeconds: number | ""; maxSeconds: number | ""; fallbackText: string; reason: string } | null;
  usageText: string;
  minimumTier: TextCommandMinimumTier;
}

export const convertLeadingSlashCommand = <Draft extends SlashConvertibleDraft>(
  draft: Draft,
  parsed: Extract<LeadingSlashCommand, { status: "valid" }>,
  shoutoutDefaults: { text: string; usageText: string },
): Draft => {
  if (parsed.command === "announce") {
    return { ...draft, kind: "text", text: parsed.bodyText, responseType: "announcement", timeoutAction: null };
  }

  if (parsed.command === "shoutout") {
    return {
      ...draft,
      kind: "shoutout",
      text: parsed.bodyText.trim().length > 0 ? parsed.bodyText.trim() : shoutoutDefaults.text,
      responseType: "say",
      variableAction: null,
      timeoutAction: null,
      usageText: draft.usageText.trim().length > 0 ? draft.usageText : shoutoutDefaults.usageText,
      minimumTier: draft.minimumTier,
    };
  }

  const currentAction = draft.timeoutAction;
  return {
    ...draft,
    kind: "timeout",
    text: parsed.bodyText,
    timeoutAction: {
      minSeconds: parsed.minSeconds ?? 0,
      maxSeconds: parsed.maxSeconds ?? 0,
      reason: parsed.reason ?? "",
      fallbackText: currentAction?.fallbackText ?? "",
    },
  };
};
