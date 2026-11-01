import type { ModuleChatCommandDeclaration } from "../../contract";

export const TEMP_VIPS_CHAT_COMMANDS = [
  {
    name: "!vip",
    syntax: "!vip @name [duration]",
    description: {
      de: "Vergibt oder verlängert ein zeitlich begrenztes VIP.",
      en: "Grants or extends a temporary VIP.",
    },
    arguments: [
      { name: "@name", hint: { de: "Twitch-Login des VIPs.", en: "Twitch login to grant VIP to." } },
      { name: "duration", hint: { de: "Dauer wie 30m, 12h oder 7t; ohne Angabe gilt die eingestellte Standarddauer.", en: "Duration such as 30m, 12h, or 7d; omit it to use the configured default." } },
    ],
    minimumChatStatus: "moderator",
  },
  {
    name: "!unvip",
    syntax: "!unvip @name",
    description: {
      de: "Beendet ein vom Bot verwaltetes zeitlich begrenztes VIP.",
      en: "Ends a bot-managed temporary VIP.",
    },
    arguments: [{ name: "@name", hint: { de: "Twitch-Login des VIPs.", en: "Twitch login of the VIP." } }],
    minimumChatStatus: "moderator",
  },
  {
    name: "!viptime",
    syntax: "!viptime [@name]",
    description: {
      de: "Zeigt das Ablaufdatum eines zeitlich begrenzten VIPs.",
      en: "Shows when a temporary VIP ends.",
    },
    arguments: [{ name: "@name", hint: { de: "Optionaler Twitch-Login; ohne Angabe wird dein eigener Status geprüft.", en: "Optional Twitch login; without one, checks your own status." } }],
    minimumChatStatus: "everyone",
  },
] as const satisfies readonly ModuleChatCommandDeclaration[];
