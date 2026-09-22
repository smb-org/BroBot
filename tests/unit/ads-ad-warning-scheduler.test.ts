import { afterEach, describe, expect, it, vi } from "vitest";

import { processAdPrewarning, type AdScheduler } from "../../src/worker/ad-prewarning";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

/**
 * When the prewarning runs inside the Durable Object, it must never address the
 * channel object through its own binding. That would be a self-call: the input
 * gate queues the request behind the running alarm that is waiting on it.
 *
 * These tests pin down the rule by making the binding throw on access and
 * counting `idFromName` calls — they fail as soon as someone builds a stub
 * again instead of using the scheduler that was passed in.
 */
describe("ad prewarning in the channel object", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  const idFromName = vi.fn();

  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client",
    TWITCH_CLIENT_SECRET: "secret",
    CHANNEL: {
      idFromName,
      get: () => { throw new Error("Selbstaufruf auf das eigene Kanalobjekt"); },
    } as unknown as Env["CHANNEL"],
  });

  const noNetwork: typeof fetch = () => { throw new Error("Es darf kein Twitch-Aufruf entstehen."); };

  const schedulerStub = (): AdScheduler & { readonly scheduled: number[]; cleared: () => number } => {
    const scheduled: number[] = [];
    let cleared = 0;
    return {
      scheduled,
      cleared: () => cleared,
      schedule: (dueAtMs: number) => { scheduled.push(dueAtMs); return Promise.resolve(); },
      clear: () => { cleared += 1; return Promise.resolve(); },
    };
  };

  it("clears the alarm through the scheduler passed in, not through the channel binding", async () => {
    database = new TestD1Database();
    idFromName.mockClear();
    await insertChannel(database, "kanal-a");
    // The broadcaster hasn't granted channel:read:ads: exactly the path
    // that wants to clear the alarm.
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatic":"a","manual":"m","prewarning":true,"leadSeconds":60,"prewarningText":"gleich {seconds}"}')`,
    ).run();

    const scheduler = schedulerStub();
    await processAdPrewarning(
      environment(),
      "kanal-a",
      Date.parse("2026-09-21T12:00:00.000Z"),
      "ausloeser-1",
      "2026-09-21T11:59:00.000Z",
      noNetwork,
      scheduler,
    );

    expect(idFromName).not.toHaveBeenCalled();
    expect(scheduler.cleared()).toBe(1);

    const rows = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a' ORDER BY rowid",
    ).all<{ code: string }>();
    expect(rows.results.map((row) => row.code)).toEqual(["ads.prewarning.scope_missing"]);
  });

  it("doesn't touch the channel binding either when the module is disabled", async () => {
    database = new TestD1Database();
    idFromName.mockClear();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 0, '{}')",
    ).run();

    await processAdPrewarning(
      environment(),
      "kanal-a",
      Date.parse("2026-09-21T12:00:00.000Z"),
      "ausloeser-2",
      "2026-09-21T11:59:00.000Z",
      noNetwork,
      schedulerStub(),
    );

    expect(idFromName).not.toHaveBeenCalled();
  });
});
