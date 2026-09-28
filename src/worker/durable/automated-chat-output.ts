export const AUTOMATED_CHAT_OUTPUT_INTERVAL_MS = 5_000;
export const AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY = "module_alarm:last_chat_attempt";
export const RECENT_BOT_CHAT_MESSAGES_STORAGE_KEY = "channel:recent_bot_chat_messages";
export const RECENT_BOT_CHAT_MESSAGE_TTL_MS = 10 * 60 * 1_000;
export const RECENT_BOT_CHAT_MESSAGE_LIMIT = 20;

interface ChatOutputTransaction {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

interface ChatOutputStorage {
  get(key: string): Promise<unknown>;
  transaction<Result>(closure: (transaction: ChatOutputTransaction) => Promise<Result>): Promise<Result>;
}

interface RecentBotChatMessage {
  senderId: string;
  text: string;
  sentAt: number;
}

interface RecentBotIdentity {
  senderId: string;
  usedAt: number;
}

interface RecentBotChatState {
  messages: RecentBotChatMessage[];
  identities: RecentBotIdentity[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recentMessagesFrom = (value: unknown, now: number): RecentBotChatMessage[] => {
  const stored = Array.isArray(value) ? value : isRecord(value) ? value.messages : null;
  if (!Array.isArray(stored)) return [];
  return stored.filter((item): item is RecentBotChatMessage => isRecord(item) &&
    typeof item.senderId === "string" && typeof item.text === "string" &&
    typeof item.sentAt === "number" && Number.isFinite(item.sentAt) &&
    item.sentAt <= now && now - item.sentAt <= RECENT_BOT_CHAT_MESSAGE_TTL_MS)
    .slice(-RECENT_BOT_CHAT_MESSAGE_LIMIT);
};

const recentIdentitiesFrom = (value: unknown, now: number): RecentBotIdentity[] => {
  if (!isRecord(value) || !Array.isArray(value.identities)) return [];
  return value.identities.filter((item): item is RecentBotIdentity => isRecord(item) &&
    typeof item.senderId === "string" && typeof item.usedAt === "number" && Number.isFinite(item.usedAt) &&
    item.usedAt <= now && now - item.usedAt <= RECENT_BOT_CHAT_MESSAGE_TTL_MS);
};

export const claimAutomatedChatOutput = async (storage: ChatOutputStorage, now: number): Promise<boolean> =>
  storage.transaction((transaction) => claimAutomatedChatOutputInTransaction(transaction, now));

export const claimAutomatedChatOutputInTransaction = async (
  transaction: ChatOutputTransaction,
  now: number,
): Promise<boolean> => {
  const lastAttemptAt = await transaction.get(AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY);
  if (typeof lastAttemptAt === "number" && now - lastAttemptAt < AUTOMATED_CHAT_OUTPUT_INTERVAL_MS) return false;
  await transaction.put(AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY, now);
  return true;
};

export const recordRecentBotChatMessage = async (
  storage: ChatOutputStorage,
  senderId: string,
  text: string,
  now: number,
): Promise<void> => storage.transaction(async (transaction) => {
  const stored = await transaction.get(RECENT_BOT_CHAT_MESSAGES_STORAGE_KEY);
  const messages = recentMessagesFrom(stored, now);
  messages.push({ senderId, text, sentAt: now });
  const identities = recentIdentitiesFrom(stored, now);
  const knownIdentity = identities.find((identity) => identity.senderId === senderId);
  if (knownIdentity === undefined) identities.push({ senderId, usedAt: now });
  else knownIdentity.usedAt = now;
  await transaction.put(
    RECENT_BOT_CHAT_MESSAGES_STORAGE_KEY,
    {
      messages: messages.slice(-RECENT_BOT_CHAT_MESSAGE_LIMIT),
      identities,
    } satisfies RecentBotChatState,
  );
});

export const isRecentBotChatMessage = async (
  storage: ChatOutputStorage,
  senderId: string | null,
  text: string,
  now: number,
): Promise<boolean> => {
  const stored = await storage.get(RECENT_BOT_CHAT_MESSAGES_STORAGE_KEY);
  const identities = recentIdentitiesFrom(stored, now);
  const isBotIdentity = senderId !== null && identities.some((identity) => identity.senderId === senderId);
  if (isBotIdentity) return true;
  // An ordinary viewer, identified by user id, cannot be the bot echoing its
  // own output: only an unverified sender (no id) still needs the text guard.
  if (senderId !== null) return false;
  const messages = recentMessagesFrom(stored, now);
  return messages.some((message) => message.text === text);
};
