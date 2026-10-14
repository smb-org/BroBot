import type { ModuleChatCommandDeclaration } from "../../contract";

export const TEXT_COMMAND_CHAT_COMMANDS = [
  {
    name: "!befehle",
    syntax: "!befehle",
    description: {
      de: "Listet alle eingeschalteten Textbefehle des Kanals auf.",
      en: "Lists all enabled text commands for the channel.",
    },
    minimumChatStatus: "everyone",
  },
] as const satisfies readonly ModuleChatCommandDeclaration[];
