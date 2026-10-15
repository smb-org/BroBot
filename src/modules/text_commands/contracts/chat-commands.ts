import type { ModuleChatCommandDeclaration } from "../../contract";

export const textCommandListChatCommand = (name: string): ModuleChatCommandDeclaration => ({
  name: `!${name}`,
  syntax: `!${name}`,
  description: {
    de: "Listet alle eingeschalteten Textbefehle des Kanals auf.",
    en: "Lists all enabled text commands for the channel.",
  },
  minimumChatStatus: "everyone",
});
