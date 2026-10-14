import type { LocaleCatalog } from "./locale";

interface ChatTargetFieldTexts {
  sharedChatInfo: string;
  allChats: string;
  allChatsDescription: string;
  onlyOurChat: string;
  onlyOurChatDescription: string;
  automatic: string;
  automaticDescription: string;
  channelDefault: (effectiveTarget?: string) => string;
  channelDefaultDescription: (effectiveTarget?: string) => string;
}

export const chatTargetFieldTexts: LocaleCatalog<ChatTargetFieldTexts> = {
  de: {
    sharedChatInfo: "Diese Einstellung wirkt sich nur während eines Shared Chats aus. Twitch kann in einer Shared-Chat-Sitzung keinen einzelnen Partnerchat gezielt ansteuern.",
    allChats: "Alle Chats",
    allChatsDescription: "In allen Chats der Shared-Chat-Sitzung",
    onlyOurChat: "Nur unser Chat",
    onlyOurChatDescription: "Nur in unserem Chat",
    automatic: "Automatisch",
    automaticDescription: "Fragen aus unserem Chat: nur hier. Fragen aus Partnerchats: in allen Chats.",
    channelDefault: (effectiveTarget) => effectiveTarget === undefined ? "Kanaleinstellung verwenden" : `Kanaleinstellung verwenden (${effectiveTarget})`,
    channelDefaultDescription: (effectiveTarget) => effectiveTarget === undefined
      ? "Das kanalweite Standard-Chat-Ziel verwenden."
      : `Das kanalweite Standard-Chat-Ziel verwenden. Aktuell: ${effectiveTarget}.`,
  },
  en: {
    sharedChatInfo: "This setting only affects output during Shared Chat. Twitch cannot target a single partner chat within a Shared Chat session.",
    allChats: "All chats",
    allChatsDescription: "All chats in the Shared Chat session",
    onlyOurChat: "Only our chat",
    onlyOurChatDescription: "Only in our chat",
    automatic: "Automatic",
    automaticDescription: "Questions from our chat: here only. Questions from partner chats: in all chats.",
    channelDefault: (effectiveTarget) => effectiveTarget === undefined ? "Use channel default" : `Use channel default (${effectiveTarget})`,
    channelDefaultDescription: (effectiveTarget) => effectiveTarget === undefined
      ? "Use the channel-wide default chat target."
      : `Use the channel-wide default chat target. Current value: ${effectiveTarget}.`,
  },
};
