import type { TemplateFields, TemplateVariable } from "../contract";

export type TextCommandKind = "text" | "list";
export const TEXT_COMMAND_MINIMUM_TIERS = ["everyone", "subscriber", "vip", "moderator", "broadcaster"] as const;
export type TextCommandMinimumTier = (typeof TEXT_COMMAND_MINIMUM_TIERS)[number];

export interface TextCommand {
  channelId: string;
  name: string;
  text: string;
  kind: TextCommandKind;
  enabled: boolean;
  minimumTier: TextCommandMinimumTier;
  cooldownSeconds: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTextCommand {
  channelId: string;
  name: string;
  text: string;
  kind: TextCommandKind;
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  now: string;
}

export interface TextCommandChange {
  channelId: string;
  name: string;
  newName: string;
  text: string;
  kind: TextCommandKind;
  enabled: boolean;
  onlyToggle?: boolean;
  minimumTier?: TextCommandMinimumTier;
  cooldownSeconds: number;
  now: string;
}

export interface TextCommandClaim {
  command: TextCommand;
  claimed: boolean;
}

export interface TextCommandActor {
  userId: string;
  sessionId?: string;
}

export const TEXT_COMMAND_VARIABLES = [
  { name: "user", sample: "zuschauerin", maxLength: 25 },
  { name: "channel", sample: "beispielkanal", maxLength: 25 },
] as const satisfies readonly TemplateVariable[];

export const TEXT_COMMAND_TEMPLATE_FIELDS = {
  text: TEXT_COMMAND_VARIABLES,
} as const satisfies TemplateFields<Pick<TextCommand, "text">>;
