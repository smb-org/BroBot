import type { LocaleCatalog } from "./locale";

interface ChatOutputTargetTexts {
  sharedChatInfo: string;
  allChats: string;
  onlyOurChat: string;
  whereAsked: string;
}

export const chatOutputTargetTexts: LocaleCatalog<ChatOutputTargetTexts> = {
  de: {
    sharedChatInfo: "Diese Einstellung wirkt sich nur während eines Shared Chats aus.",
    allChats: "Alle Chats",
    onlyOurChat: "Nur unser Chat",
    whereAsked: "Wo gefragt",
  },
  en: {
    sharedChatInfo: "This setting only affects output during Shared Chat.",
    allChats: "All chats",
    onlyOurChat: "Only our chat",
    whereAsked: "Where it was asked",
  },
};
