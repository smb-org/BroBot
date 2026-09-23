import type { TemplateFields, TemplateVariable } from "../contract";

export const TEXT_COMMAND_KINDS = ["text", "list", "uptime", "followage", "game", "shoutout"] as const;
export type TextCommandKind = (typeof TEXT_COMMAND_KINDS)[number];
export const TEXT_COMMAND_MINIMUM_TIERS = ["everyone", "subscriber", "vip", "moderator", "broadcaster"] as const;
export type TextCommandMinimumTier = (typeof TEXT_COMMAND_MINIMUM_TIERS)[number];
export const TEXT_COMMAND_RESPONSE_TYPES = ["say", "reply", "announcement"] as const;
export type TextCommandResponseType = (typeof TEXT_COMMAND_RESPONSE_TYPES)[number];
export const TEXT_COMMAND_STREAM_CONDITIONS = ["any", "online", "offline"] as const;
export type TextCommandStreamCondition = (typeof TEXT_COMMAND_STREAM_CONDITIONS)[number];
export const TEXT_COMMAND_MAX_ALIASES = 10;

export interface TextCommand {
  channelId: string;
  name: string;
  text: string;
  kind: TextCommandKind;
  offlineText?: string;
  notFollowingText?: string;
  unavailableText?: string;
  usageText?: string;
  enabled: boolean;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases: readonly string[];
  userCooldownSeconds: number;
  streamCondition: TextCommandStreamCondition;
  responseType: TextCommandResponseType;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface NewTextCommand {
  channelId: string;
  name: string;
  text: string;
  kind: TextCommandKind;
  offlineText?: string;
  notFollowingText?: string;
  unavailableText?: string;
  usageText?: string;
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases?: readonly string[];
  userCooldownSeconds?: number;
  streamCondition?: TextCommandStreamCondition;
  responseType?: TextCommandResponseType;
  now: string;
}

export interface TextCommandChange {
  channelId: string;
  name: string;
  newName: string;
  text: string;
  kind: TextCommandKind;
  offlineText?: string;
  notFollowingText?: string;
  unavailableText?: string;
  usageText?: string;
  enabled: boolean;
  onlyToggle?: boolean;
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases: readonly string[];
  userCooldownSeconds: number;
  streamCondition: TextCommandStreamCondition;
  responseType: TextCommandResponseType;
  expectedRevision?: number;
  now: string;
}

export interface TextCommandClaim {
  command: TextCommand;
  claimed: boolean;
  reason?: "cooldown" | "user_cooldown";
  remainingSeconds?: number;
}

export interface TextCommandActor {
  userId: string;
  sessionId?: string;
}

export const TEXT_COMMAND_VARIABLES = [
  { name: "user", sample: "zuschauerin", maxLength: 25 },
  { name: "channel", sample: "beispielkanal", maxLength: 25 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_UPTIME_VARIABLES = [
  ...TEXT_COMMAND_VARIABLES,
  { name: "uptime", sample: "2 Std. 14 Min.", maxLength: 32 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_FOLLOWAGE_VARIABLES = [
  ...TEXT_COMMAND_VARIABLES,
  { name: "followage", sample: "1 Jahr, 3 Monate", maxLength: 48 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_GAME_VARIABLES = [
  TEXT_COMMAND_VARIABLES[1],
  { name: "game", sample: "Minecraft", maxLength: 100 },
  { name: "title", sample: "A cozy evening", maxLength: 140 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_SHOUTOUT_VARIABLES = [
  TEXT_COMMAND_VARIABLES[0],
  { name: "target", sample: "streamerin", maxLength: 25 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_TEMPLATE_FIELDS = {
  text: { text: TEXT_COMMAND_VARIABLES },
  list: {},
  uptime: {
    text: TEXT_COMMAND_UPTIME_VARIABLES,
    offlineText: [TEXT_COMMAND_VARIABLES[1]],
  },
  followage: {
    text: TEXT_COMMAND_FOLLOWAGE_VARIABLES,
    notFollowingText: TEXT_COMMAND_VARIABLES,
    unavailableText: [],
  },
  game: { text: TEXT_COMMAND_GAME_VARIABLES },
  shoutout: {
    text: TEXT_COMMAND_SHOUTOUT_VARIABLES,
    usageText: [],
  },
} as const satisfies Readonly<Record<TextCommandKind, TemplateFields<TextCommand>>>;
