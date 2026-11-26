import { z } from "zod";

export const DISCORD_MODULE_ID = "discord";
export const DISCORD_LINK_PAGE_PATH = "/discord/link";
export const DISCORD_COMMAND = "!discord";

export const discordSettingsSchema = z.object({
  chatHintEnabled: z.boolean().default(true),
});

export type DiscordServerConnectionState =
  | "not_connected"
  | "connected"
  | "bot_removed"
  | "permissions_missing"
  | "role_too_low"
  | "could_not_check"
  | "not_available";

export interface DiscordServerConnection {
  channelId: string;
  guildId: string;
  connectedAt: string;
  connectedBy: string;
}

export interface DiscordRoleMappings {
  vip: string | null;
  moderator: string | null;
}

export interface DiscordServerRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
}
