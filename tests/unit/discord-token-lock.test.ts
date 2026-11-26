import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimDiscordBotTokenProbe,
  clearClaimedDiscordBotTokenLock,
  clearDiscordBotTokenLock,
  probeDiscordBotToken,
  readDiscordBotTokenLock,
  setDiscordBotTokenLock,
} from "../../src/worker/discord/token-lock";
import { TestD1Database } from "./test-d1";

const databases: TestD1Database[] = [];
const environment = {
  APP_ENV: "local" as const,
  DISCORD_API_BASE: "http://discord.example/api/v10",
  DISCORD_BOT_TOKEN: "fictional-discord-bot-token",
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

describe("global Discord bot token lock", () => {
  it("stores one lock row and clears it after a successful bot identity probe", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await setDiscordBotTokenLock(database as unknown as D1Database, "2026-11-26T10:00:00.000Z");
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ id: "990000000000000099", username: "brobot_test", bot: true })));

    const result = await probeDiscordBotToken(environment, database as unknown as D1Database, "2026-11-26T11:00:00.000Z", fetcher);

    expect(result).toEqual({ ok: true, wasLocked: true, probed: true });
    await expect(readDiscordBotTokenLock(database as unknown as D1Database)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await clearDiscordBotTokenLock(database as unknown as D1Database)).toBe(false);
  });

  it("allows only one concurrent probe claim and clears only that claimant's lock", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const db = database as unknown as D1Database;
    await setDiscordBotTokenLock(db, "2026-11-26T10:00:00.000Z");
    const claimed = await claimDiscordBotTokenProbe(
      db,
      "2026-11-26T10:00:00.000Z",
      "2026-11-26T11:00:00.000Z",
      "fictional-probe-one",
      "2026-11-26T11:00:30.000Z",
      "2026-11-26T11:00:00.000Z",
    );
    const overlap = await claimDiscordBotTokenProbe(
      db,
      "2026-11-26T11:00:00.000Z",
      "2026-11-26T11:00:01.000Z",
      "fictional-probe-two",
      "2026-11-26T11:00:31.000Z",
      "2026-11-26T11:00:01.000Z",
    );

    expect(claimed).toBe(true);
    expect(overlap).toBe(false);
    expect(await clearClaimedDiscordBotTokenLock(db, "2026-11-26T11:00:00.000Z", "fictional-probe-two")).toBe(false);
    await expect(readDiscordBotTokenLock(db)).resolves.toMatchObject({ lockedAt: "2026-11-26T10:00:00.000Z" });
    expect(await clearClaimedDiscordBotTokenLock(db, "2026-11-26T11:00:00.000Z", "fictional-probe-one")).toBe(true);
  });

  it("does not let a manual probe bypass Discord's retry_after deadline", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const db = database as unknown as D1Database;
    await setDiscordBotTokenLock(db, "2026-11-26T10:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T11:00:00.000Z"));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ retry_after: 75, global: true }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: "990000000000000099", username: "brobot_test", bot: true }));

    await expect(probeDiscordBotToken(environment, db, new Date(Date.now()).toISOString(), fetcher))
      .resolves.toMatchObject({ ok: false, probed: true });
    const retryAt = Date.now() + 75_000;
    await expect(probeDiscordBotToken(environment, db, new Date(retryAt - 1).toISOString(), fetcher))
      .resolves.toEqual({ ok: false, wasLocked: true, probed: false });
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(retryAt));
    await expect(probeDiscordBotToken(environment, db, new Date(retryAt).toISOString(), fetcher))
      .resolves.toMatchObject({ ok: true, wasLocked: true, probed: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
