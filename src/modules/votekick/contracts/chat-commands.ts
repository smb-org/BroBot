import type { ModuleChatCommandDeclaration } from "../../contract";

export const VOTEKICK_CHAT_COMMANDS = [
  {
    name: "!votekick",
    syntax: "!votekick @user",
    description: {
      de: "Startet eine Abstimmung über einen aktiven Chatter.",
      en: "Starts a vote about an active chatter.",
    },
    arguments: [{
      name: "@user",
      hint: {
        de: "Twitch-Login des aktiven Chatters, der für einen Timeout vorgeschlagen wird.",
        en: "Twitch login of the active chatter proposed for a timeout.",
      },
    }],
    minimumChatStatus: "configurable",
  },
] as const satisfies readonly ModuleChatCommandDeclaration[];
