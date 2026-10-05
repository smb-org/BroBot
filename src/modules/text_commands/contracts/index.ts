import type { ChannelVariableOperation } from "../../../contracts/values";
import type { ChatOutputTarget } from "../../contract";
import { MODULE_TEMPLATE_MINIMUM_TIERS, MODULE_TEMPLATE_TIER_CHAT_STATUSES, type ModuleTemplateMinimumTier } from "../../contract";
import type { TemplateFields } from "../contract";
import type { TimeoutDurationRange } from "../../contracts/moderation";
import { TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES } from "./template-variable-catalog";

export { TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES } from "./template-variable-catalog";

export const TEXT_COMMAND_KINDS = ["text", "list", "shoutout", "timeout"] as const;
export type TextCommandKind = (typeof TEXT_COMMAND_KINDS)[number];
export const TEXT_COMMAND_MINIMUM_TIERS = MODULE_TEMPLATE_MINIMUM_TIERS;
export type TextCommandMinimumTier = ModuleTemplateMinimumTier;
/** Compatibility name for the shared module tier badge ladder. */
export const TEXT_COMMAND_TIER_CHAT_STATUSES = MODULE_TEMPLATE_TIER_CHAT_STATUSES;
export const TEXT_COMMAND_RESPONSE_TYPES = ["say", "reply", "announcement"] as const;
export type TextCommandResponseType = (typeof TEXT_COMMAND_RESPONSE_TYPES)[number];
export const TEXT_COMMAND_STREAM_CONDITIONS = ["any", "online", "offline"] as const;
export type TextCommandStreamCondition = (typeof TEXT_COMMAND_STREAM_CONDITIONS)[number];
export const TEXT_COMMAND_MAX_ALIASES = 10;

export interface TextCommandTimeoutAction extends TimeoutDurationRange {
  fallbackText: string;
  reason?: string;
}

export interface TextCommandGame {
  id: string;
  name: string;
  /** Helix box_art_url template; absent on older persisted game entries. */
  boxArtUrlTemplate?: string;
}

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
  games?: readonly TextCommandGame[];
  responseType: TextCommandResponseType;
  chatTarget: ChatOutputTarget;
  variableAction: TextCommandVariableAction | null;
  timeoutAction: TextCommandTimeoutAction | null;
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
  claim: { commandName: string; revision: number; userId: string | null },
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
  games?: readonly TextCommandGame[];
  responseType?: TextCommandResponseType;
  chatTarget?: ChatOutputTarget;
  variableAction?: TextCommandVariableAction | null;
  timeoutAction?: TextCommandTimeoutAction | null;
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
  games?: readonly TextCommandGame[];
  responseType: TextCommandResponseType;
  chatTarget?: ChatOutputTarget;
  variableAction?: TextCommandVariableAction | null;
  timeoutAction?: TextCommandTimeoutAction | null;
  expectedRevision?: number;
  now: string;
}

export interface TextCommandClaim {
  command: TextCommand;
  claimed: boolean;
  stale?: boolean;
  changedVariable?: { name: string; value: number };
  changedVariableOverlayIds?: readonly string[];
  reason?: "cooldown" | "user_cooldown" | "variable_update_failed";
  remainingSeconds?: number;
}

export interface TextCommandActor {
  userId: string;
  sessionId?: string;
}

export const TEXT_COMMAND_TEMPLATE_FIELDS = {
  text: { text: TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, usageText: [] },
  timeout: { text: TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, usageText: [] },
  list: {},
  shoutout: { text: [], usageText: [] },
} as const satisfies Readonly<Record<TextCommandKind, TemplateFields<TextCommand>>>;
