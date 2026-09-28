import type { LocaleCatalog } from "./locale";

interface ChatOutputTargetTexts {
  sharedChatInfo: string;
  allChats: string;
  allChatsDescription: string;
  onlyOurChat: string;
  onlyOurChatDescription: string;
  automatic: string;
  automaticDescription: string;
}

export const chatOutputTargetTexts: LocaleCatalog<ChatOutputTargetTexts> = {
  de: {
    sharedChatInfo:
      "Diese Einstellung wirkt sich nur während eines Shared Chats aus. Twitch kann in einer Shared-Chat-Sitzung keinen einzelnen Partnerchat gezielt ansteuern.",
    allChats: "Alle Chats",
    allChatsDescription: "In allen Chats der Shared-Chat-Sitzung",
    onlyOurChat: "Nur unser Chat",
    onlyOurChatDescription: "Nur in unserem Chat",
    automatic: "Automatisch",
    automaticDescription:
      "Fragen aus unserem Chat: nur hier. Fragen aus Partnerchats: in allen Chats (Twitch kann keinen einzelnen Partnerchat ansteuern).",
  },
  en: {
    sharedChatInfo:
      "This setting only affects output during Shared Chat. Twitch cannot target a single partner chat within a Shared Chat session.",
    allChats: "All chats",
    allChatsDescription: "All chats in the Shared Chat session",
    onlyOurChat: "Only our chat",
    onlyOurChatDescription: "Only in our chat",
    automatic: "Automatic",
    automaticDescription:
      "Questions from our chat: here only. Questions from partner chats: in all chats (Twitch cannot target a single partner chat).",
  },
};
