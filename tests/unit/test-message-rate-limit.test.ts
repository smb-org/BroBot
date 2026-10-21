import { describe, expect, it } from "vitest";

import { claimTestMessageSend } from "../../src/worker/durable/test-message-rate-limit";

const storageFor = (values = new Map<string, unknown>()) => ({
  values,
  transaction: async <Value>(operation: (transaction: {
    get: <Entry>(key: string) => Promise<Entry | undefined>;
    put: (key: string, value: unknown) => Promise<void>;
  }) => Promise<Value>): Promise<Value> => await operation({
    get: <Entry>(key: string): Promise<Entry | undefined> => Promise.resolve(values.get(key) as Entry | undefined),
    put: (key, value): Promise<void> => { values.set(key, value); return Promise.resolve(); },
  }),
});

describe("test message per-channel rate limit", () => {
  it("allows one claim per 30 seconds and returns the remaining delay", async () => {
    const storage = storageFor();

    await expect(claimTestMessageSend(storage, 1_000)).resolves.toEqual({ allowed: true });
    await expect(claimTestMessageSend(storage, 2_000)).resolves.toEqual({ allowed: false, retryAfter: 29 });
    await expect(claimTestMessageSend(storage, 31_000)).resolves.toEqual({ allowed: true });
  });

  it("does not share rate-limit state between channels", async () => {
    const channelA = storageFor();
    const channelB = storageFor();

    await expect(claimTestMessageSend(channelA, 1_000)).resolves.toEqual({ allowed: true });
    await expect(claimTestMessageSend(channelB, 1_000)).resolves.toEqual({ allowed: true });
  });
});
