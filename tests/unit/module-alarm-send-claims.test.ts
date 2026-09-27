import { describe, expect, it } from "vitest";

import {
  claimModuleAlarmSend,
  finishModuleAlarmSend,
  readModuleAlarmSendClaim,
  type ClaimStorage,
} from "../../src/worker/durable/module-alarm-send-claims";

const storageFor = (): ClaimStorage => {
  const values = new Map<string, unknown>();
  let queue = Promise.resolve();
  return {
    get: (key) => Promise.resolve(values.get(key)),
    transaction: async (closure) => {
      const predecessor = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await predecessor;
      try {
        return await closure({
          get: (key) => Promise.resolve(values.get(key)),
          put: (key, value) => {
            values.set(key, value);
            return Promise.resolve();
          },
        });
      } finally {
        release();
      }
    },
  };
};

describe("module alarm send claims", () => {
  it("releases a rejected occurrence for retry and keeps ambiguous outcomes claimed", async () => {
    const storage = storageFor();

    expect(await claimModuleAlarmSend(storage, "occurrence-a", 10_000)).toBe(true);
    await finishModuleAlarmSend(storage, "occurrence-a", "rejected", 10_000);
    expect(await claimModuleAlarmSend(storage, "occurrence-a", 15_000)).toBe(true);
    await finishModuleAlarmSend(storage, "occurrence-a", "sent", 15_000);
    expect(await claimModuleAlarmSend(storage, "occurrence-a", 20_000)).toBe(false);

    expect(await claimModuleAlarmSend(storage, "occurrence-b", 20_000)).toBe(true);
    await finishModuleAlarmSend(storage, "occurrence-b", "ambiguous", 20_000);
    expect(await readModuleAlarmSendClaim(storage, "occurrence-b")).toMatchObject({ status: "sending" });
    expect(await claimModuleAlarmSend(storage, "occurrence-b", 25_000)).toBe(false);
  });

  it("limits timer alarm posts to one attempt per channel every five seconds", async () => {
    const storage = storageFor();

    expect(await claimModuleAlarmSend(storage, "first", 10_000)).toBe(true);
    expect(await claimModuleAlarmSend(storage, "second", 14_999)).toBe("rate_limited");
    expect(await claimModuleAlarmSend(storage, "second", 15_000)).toBe(true);
  });
});
