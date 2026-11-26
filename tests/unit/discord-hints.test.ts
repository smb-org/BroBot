import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { discordModule } from "../../src/modules/discord";
import {
  claimModuleAlarmSend,
  finishModuleAlarmSend,
  readModuleAlarmSendClaim,
} from "../../src/worker/durable/module-alarm-send-claims";
import { TestD1Database } from "./test-d1";
import { insertChannel } from "./fixtures";

const CHANNEL_ID = "discord-hint-channel-fictional";
const GUILD_ID = "990000000000000101";
const TWITCH_USER_ID = "990000000000000301";
const DISCORD_USER_ID = "990000000000000201";

describe("Discord link chat hint", () => {
  const databases: TestD1Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.sqlite.close();
    vi.unstubAllGlobals();
  });

  const makeContext = async (sentResults: boolean[], linked = false) => {
    const DB = new TestD1Database();
    databases.push(DB);
    await insertChannel(DB, CHANNEL_ID, "Fictional Harbor");
    await DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(CHANNEL_ID).run();
    await DB.prepare(
      "INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by) VALUES (?, ?, ?, ?)",
    ).bind(CHANNEL_ID, GUILD_ID, "2026-11-26T10:00:00.000Z", "fictional-manager").run();
    if (linked) await DB.prepare(
      `INSERT INTO discord_links
        (discord_user_id, twitch_user_id, discord_username, twitch_login, linked_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(DISCORD_USER_ID, TWITCH_USER_ID, "Fictional Viewer", "pixelpilot", "2026-11-26T10:00:00.000Z", "2026-11-26T10:00:00.000Z").run();
    const sentHints = new Set<string>();
    const eligible = vi.fn(() => Promise.resolve(true));
    const record = vi.fn((userId: string) => {
      sentHints.add(userId);
      return Promise.resolve();
    });
    const object = {
      discordHintEligible: eligible,
      discordChatHintWasSent: (userId: string) => Promise.resolve(sentHints.has(userId)),
      recordDiscordChatHint: record,
    };
    const environment = {
      PUBLIC_ORIGIN: "https://brobot.example",
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => object,
      },
    };
    let sendIndex = 0;
    const sendChat = vi.fn<(text: string, idempotencyKey: string) => Promise<{ sent: boolean; delivery: "sent" | "not_attempted"; reason: string | null }>>(() => {
      const sent = sentResults[sendIndex++] ?? false;
      return Promise.resolve({ sent, delivery: sent ? "sent" as const : "not_attempted" as const, reason: sent ? null : "automated_output_limit" });
    });
    return {
      DB,
      eligible,
      record,
      sendChat,
      run: async (subscriptionType: string, chatHintEnabled = true) => await discordModule.handleEvent?.({
        channelId: CHANNEL_ID,
        subscriptionType,
        payload: { user_id: TWITCH_USER_ID },
        settings: { chatHintEnabled },
      } as unknown as ModuleEvent<{ chatHintEnabled: boolean }>, {
        DB: DB as unknown as D1Database,
        channelId: CHANNEL_ID,
        environment: environment as unknown as Env,
        sendChat,
      } as unknown as ModuleExecutionContext),
    };
  };

  it("sends live add hints once and records only a successful send", async () => {
    const context = await makeContext([true]);

    await context.run("channel.vip.add");
    await context.run("channel.vip.add");

    expect(context.sendChat).toHaveBeenCalledTimes(1);
    expect(context.sendChat.mock.calls[0]?.[0]).toContain("https://brobot.example/discord/link");
    expect(context.record).toHaveBeenCalledTimes(1);
  });

  it("retries rate-limited hints and ignores snapshots, removals, linked viewers, and the off switch", async () => {
    const context = await makeContext([false, true]);

    await context.run("channel.vip.add");
    expect(context.record).not.toHaveBeenCalled();
    await context.run("channel.vip.add");
    expect(context.record).toHaveBeenCalledTimes(1);
    await context.run("channel.moderator.snapshot");
    await context.run("channel.vip.remove");
    await context.run("channel.vip.add", false);
    expect(context.sendChat).toHaveBeenCalledTimes(2);

    const linked = await makeContext([true], true);
    await linked.run("channel.vip.add");
    expect(linked.sendChat).not.toHaveBeenCalled();
  });

  it("does not record a hint inside the shared five-second automated chat limit, then sends the next live add", async () => {
    const context = await makeContext([]);
    const values = new Map<string, unknown>();
    const storage = {
      get: (key: string) => Promise.resolve(values.get(key)),
      transaction: <Result>(closure: (transaction: {
        get: (key: string) => Promise<unknown>;
        put: (key: string, value: unknown) => Promise<void>;
      }) => Promise<Result>): Promise<Result> => closure({
        get: (key) => Promise.resolve(values.get(key)),
        put: (key, value) => { values.set(key, value); return Promise.resolve(); },
      }),
    };
    let now = 100_000;
    expect(await claimModuleAlarmSend(storage, "other-automated-message", now)).toBe(true);
    await finishModuleAlarmSend(storage, "other-automated-message", "sent", now);
    now += 2_000;
    context.sendChat.mockImplementation(async (_text, operationId) => {
      const claim = await claimModuleAlarmSend(storage, operationId, now);
      if (claim !== true) return { sent: false, delivery: "not_attempted", reason: "automated_output_limit" };
      await finishModuleAlarmSend(storage, operationId, "sent", now);
      return { sent: true, delivery: "sent", reason: null };
    });

    await context.run("channel.vip.add");

    expect(context.sendChat).toHaveBeenCalledTimes(1);
    expect(context.record).not.toHaveBeenCalled();
    await expect(readModuleAlarmSendClaim(storage, `discord-link-hint:${TWITCH_USER_ID}`)).resolves.toBeNull();
    now += 3_000;

    await context.run("channel.vip.add");

    expect(context.sendChat).toHaveBeenCalledTimes(2);
    expect(context.record).toHaveBeenCalledTimes(1);
    await expect(readModuleAlarmSendClaim(storage, `discord-link-hint:${TWITCH_USER_ID}`)).resolves.toMatchObject({ status: "sent" });
  });
});
