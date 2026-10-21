interface TestMessageRateLimitTransaction {
  get: <Value>(key: string) => Promise<Value | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
}

interface TestMessageRateLimitStorage {
  transaction: <Value>(operation: (transaction: TestMessageRateLimitTransaction) => Promise<Value>) => Promise<Value>;
}

const LAST_TEST_MESSAGE_AT_KEY = "quick_actions:test_message_last_send_at";

export const claimTestMessageSend = (
  storage: TestMessageRateLimitStorage,
  now: number,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> => storage.transaction(async (transaction) => {
  const previous = await transaction.get<number>(LAST_TEST_MESSAGE_AT_KEY);
  if (typeof previous !== "number" || !Number.isFinite(previous) || now - previous >= 30_000) {
    await transaction.put(LAST_TEST_MESSAGE_AT_KEY, now);
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((previous + 30_000 - now) / 1_000)),
  };
});
