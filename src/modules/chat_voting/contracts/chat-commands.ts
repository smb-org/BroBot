import type { ModuleChatCommandDeclaration } from "../../contract";

export const CHAT_VOTING_CHAT_COMMANDS = [
  {
    name: "!vote",
    syntax: "!vote [type] [question]",
    description: {
      de: "Startet oder beendet eine Chat-Abstimmung.",
      en: "Starts or ends a chat vote.",
    },
    arguments: [
      {
        name: "type",
        hint: {
          de: "Erlaubt: yesno, scale, 01, 12, text oder 2–9; end beendet Abstimmung.",
          en: "Accepted: yesno, scale, 01, 12, text, or 2–9; end closes the vote.",
        },
      },
      {
        name: "question",
        hint: {
          de: "Optionale Abstimmungsfrage.",
          en: "Optional question for the vote.",
        },
      },
    ],
    minimumChatStatus: "moderator",
  },
] as const satisfies readonly ModuleChatCommandDeclaration[];
