import type { ModuleLanguage } from "../../contract";

export const raidActionContentTexts = {
  channelName: { de: "Kanalname", en: "Channel name" },
  channelHint: { de: "Gib den Twitch-Kanal ein.", en: "Enter the Twitch channel." },
  channelRequired: { de: "Kanalname eingeben", en: "Enter a channel name" },
} as const satisfies Readonly<Record<"channelName" | "channelHint" | "channelRequired", Readonly<Record<ModuleLanguage, string>>>>;
