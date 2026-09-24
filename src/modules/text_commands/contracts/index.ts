import type { ChannelVariableOperation } from "../../../contracts/values";
import type { TemplateFields } from "../contract";

export const TEXT_COMMAND_KINDS = ["text", "list", "shoutout"] as const;
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
  /** Preserves the whole-reply fallbacks of commands migrated from legacy kinds. */
  legacyFallback?: boolean;
  /** Original kind for migrated commands whose legacy lookup does not need a template token. */
  legacyKind?: "uptime" | "followage";
  enabled: boolean;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases: readonly string[];
  userCooldownSeconds: number;
  streamCondition: TextCommandStreamCondition;
  responseType: TextCommandResponseType;
  variableAction: TextCommandVariableAction | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TextCommandVariableAction {
  name: string;
  operation: ChannelVariableOperation;
  amount: number | null;
}

export type PrepareTextCommandVariableChange = (
  channelId: string,
  change: { name: string; operation: ChannelVariableOperation; amount: number | null },
  now: string,
) => D1PreparedStatement;

export interface NewTextCommand {
  channelId: string;
  name: string;
  text: string;
  kind: TextCommandKind;
  offlineText?: string;
  notFollowingText?: string;
  unavailableText?: string;
  usageText?: string;
  legacyFallback?: boolean;
  legacyKind?: "uptime" | "followage";
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases?: readonly string[];
  userCooldownSeconds?: number;
  streamCondition?: TextCommandStreamCondition;
  responseType?: TextCommandResponseType;
  variableAction?: TextCommandVariableAction | null;
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
  legacyFallback?: boolean;
  legacyKind?: "uptime" | "followage";
  enabled: boolean;
  onlyToggle?: boolean;
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  aliases: readonly string[];
  userCooldownSeconds: number;
  streamCondition: TextCommandStreamCondition;
  responseType: TextCommandResponseType;
  variableAction?: TextCommandVariableAction | null;
  expectedRevision?: number;
  now: string;
}

export interface TextCommandClaim {
  command: TextCommand;
  claimed: boolean;
  stale?: boolean;
  changedVariable?: { name: string; value: number };
  reason?: "cooldown" | "user_cooldown" | "variable_update_failed";
  remainingSeconds?: number;
}

export interface TextCommandActor {
  userId: string;
  sessionId?: string;
}

export const TEXT_COMMAND_TEMPLATE_FIELDS = {
  text: { text: [] },
  list: {},
  shoutout: { text: [], usageText: [] },
} as const satisfies Readonly<Record<TextCommandKind, TemplateFields<TextCommand>>>;
