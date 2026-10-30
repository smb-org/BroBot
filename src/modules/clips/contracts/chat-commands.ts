import type { ModuleChatCommandDeclaration } from "../../contract";

export const CLIPS_CHAT_COMMANDS: readonly ModuleChatCommandDeclaration[] = [{
  name: "!clip",
  syntax: "!clip",
  description: {
    de: "Erstellt einen Clip aus dem aktuellen Stream.",
    en: "Creates a clip from the current stream.",
  },
  minimumChatStatus: "configurable",
  minimumChatStatusSetting: "commandMinimumRole",
}];
