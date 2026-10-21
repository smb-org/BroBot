import { expect, it } from "vitest";
import { claimModuleAlarmSend, finishModuleAlarmSend, type ClaimStorage } from "../../src/worker/durable/module-alarm-send-claims";

it("retries uncertain result sends after the grace period while keeping confirmed sends final [protects=an interrupted result send cannot block delivery forever and confirmed delivery stays deduplicated; fails_when=an uncertain send cannot retry after thirty seconds or a confirmed send can repeat; no_claim=does not prove exactly-once delivery at Twitch]", async () => {
  const values = new Map<string, unknown>();
  const get = (key: string) => Promise.resolve(values.get(key));
  const storage: ClaimStorage = {
    get,
    transaction: (closure) => closure({ get, put: (key, value) => { values.set(key, value); return Promise.resolve(); } }),
  };
  const key = "round:fictional-round:resolve";
  expect(await claimModuleAlarmSend(storage, key, 10_000, 30_000)).toBe(true);
  await finishModuleAlarmSend(storage, key, "ambiguous", 10_000);
  expect(await claimModuleAlarmSend(storage, key, 39_999, 30_000)).toBe(false);
  expect(await claimModuleAlarmSend(storage, key, 40_000, 30_000)).toBe(true);
  await finishModuleAlarmSend(storage, key, "sent", 40_000);
  expect(await claimModuleAlarmSend(storage, key, 80_000, 30_000)).toBe(false);
});
