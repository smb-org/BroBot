import { describe, expect, it, vi } from "vitest";

import type { DryRunEntryReport } from "../../src/contracts/dry-run";
import type { ModuleDryRunContext, ModuleEvent, ModuleExecutionContext, ModuleTempVipRow } from "../../src/modules/contract";
import { DEFAULT_TEMP_VIPS_SETTINGS } from "../../src/modules/temp_vips/contracts";
import type { TempVipsSettings } from "../../src/modules/temp_vips/contracts";
import { dryRunTempVipsChatMessage } from "../../src/modules/temp_vips/dry-run";
import { TEMP_VIPS_CHAT_COMMANDS } from "../../src/modules/temp_vips/contracts/chat-commands";
import { processTempVipsChatMessage } from "../../src/modules/temp_vips/service";

const target = { userId: "target-user", login: "gamer", displayName: "Gamer" };
const expiry = "2026-11-02T11:30:00.000Z";

const vipRow = (overrides: Partial<ModuleTempVipRow> = {}): ModuleTempVipRow => ({
  ...target,
  expiresAt: expiry,
  grantedAt: "2026-11-01T10:00:00.000Z",
  grantedByUserId: "mod-user",
  grantedByLogin: "moderator",
  source: "command",
  removalFailedAt: null,
  removalAttempts: 0,
  removalError: null,
  endReason: null,
  ...overrides,
});

const makeEvent = (
  text: string,
  chatStatus: readonly ("subscriber" | "vip" | "moderator" | "broadcaster")[] | null = ["moderator"],
  settings: TempVipsSettings = DEFAULT_TEMP_VIPS_SETTINGS,
): ModuleEvent<TempVipsSettings> => ({
  channelId: "channel-1",
  subscriptionType: "channel.chat.message",
  triggerId: "message-1",
  payload: {
    chatter_user_id: "mod-user",
    chatter_user_login: "moderator",
    chatter_user_name: "Moderator",
    message_id: "message-1",
    message: { text },
  },
  settings,
  receivedAt: "2026-11-01T10:00:00.000Z",
  actor: null,
  chatStatus,
});

const makeContext = (options: {
  language?: "de" | "en";
  lookup?: (login: string) => Promise<typeof target | null>;
  list?: () => Promise<ModuleTempVipRow[]>;
  grant?: (request: unknown) => Promise<{ status: string; row?: ModuleTempVipRow; allowedDurationMs?: number; reason?: string }>;
  end?: (request: unknown) => Promise<{ status: string; reason?: string }>;
} = {}): ModuleExecutionContext => ({
  channelLanguage: vi.fn(() => Promise.resolve(options.language ?? "en")),
  channelTimeZone: vi.fn(() => Promise.resolve("Europe/Berlin")),
  botUserId: vi.fn(() => Promise.resolve("bot-user")),
  lookupUserByLogin: vi.fn(options.lookup ?? ((login) => Promise.resolve({ ...target, login }))),
  tempVips: {
    grant: vi.fn(options.grant ?? (() => Promise.resolve({ status: "granted", row: vipRow() }))),
    extend: vi.fn(() => Promise.resolve({ status: "extended", row: vipRow() })),
    importExisting: vi.fn(() => Promise.resolve({ status: "imported", row: vipRow() })),
    end: vi.fn(options.end ?? (() => Promise.resolve({ status: "ended", reason: "ended_early" }))),
    release: vi.fn(() => Promise.resolve({ status: "released" })),
    list: vi.fn(options.list ?? (() => Promise.resolve([]))),
    runExpiry: vi.fn(() => Promise.resolve({ removed: 0, queued: 0 })),
    handleRemoved: vi.fn(() => Promise.resolve({ status: "ignored" })),
  },
} as unknown as ModuleExecutionContext);

describe("temporary VIP chat commands", () => {
  it("declares the three fixed commands and their chat roles", () => {
    expect(TEMP_VIPS_CHAT_COMMANDS.map(({ name }) => name)).toEqual(["!vip", "!unvip", "!viptime"]);
    expect(TEMP_VIPS_CHAT_COMMANDS.map(({ minimumChatStatus }) => minimumChatStatus)).toEqual([
      "moderator", "moderator", "everyone",
    ]);
    expect(TEMP_VIPS_CHAT_COMMANDS.every(({ description }) => description.de.length > 0 && description.en.length > 0)).toBe(true);
  });

  it("grants through the channel VIP RPC and replies in the channel time zone", async () => {
    const context = makeContext();

    const result = await processTempVipsChatMessage(makeEvent("!vip @gamer 30m"), context);

    expect(context.tempVips.grant).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "message-1",
      person: target,
      grantedBy: { userId: "mod-user", login: "moderator" },
      durationMs: 30 * 60_000,
      maximumRemainingMs: 90 * 24 * 60 * 60_000,
      source: "command",
    }));
    const reply = result.actions[0];
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") return;
    expect(reply.automated).toBe(false);
    expect(reply.text).toContain("2 Nov 2026, 12:30 (Europe/Berlin)");
  });

  it("uses the configured default duration when !vip omits one", async () => {
    const context = makeContext();
    const settings: TempVipsSettings = { ...DEFAULT_TEMP_VIPS_SETTINGS, defaultDurationDays: 3 };

    await processTempVipsChatMessage(makeEvent("!vip @gamer", ["moderator"], settings), context);

    expect(context.tempVips.grant).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 3 * 24 * 60 * 60_000 }));
  });

  it("does not run moderator commands for viewers", async () => {
    const context = makeContext();

    const result = await processTempVipsChatMessage(makeEvent("!vip @gamer 30m", []), context);

    expect(context.tempVips.grant).not.toHaveBeenCalled();
    expect(context.lookupUserByLogin).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it("lets everyone check their own managed VIP in German", async () => {
    const context = makeContext({
      language: "de",
      list: () => Promise.resolve([vipRow({ userId: "mod-user", login: "moderator", displayName: "Moderator" })]),
    });

    const result = await processTempVipsChatMessage(makeEvent("!viptime", []), context);

    expect(context.tempVips.list).toHaveBeenCalledOnce();
    expect(context.lookupUserByLogin).not.toHaveBeenCalled();
    const reply = result.actions[0];
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") return;
    expect(reply.automated).toBe(false);
    expect(reply.text).toContain("noch 1 Tag 1 Std. 30 Min.");
    expect(reply.text).toContain("02.11.2026, 12:30 (Europe/Berlin)");
  });

  it("ends only a managed VIP through the backend RPC", async () => {
    const context = makeContext();

    const result = await processTempVipsChatMessage(makeEvent("!unvip @gamer"), context);

    expect(context.tempVips.end).toHaveBeenCalledWith({ operationId: "message-1", userId: "target-user" });
    expect(result.actions[0]).toMatchObject({ kind: "chat", automated: false });
  });

  it("replies with a duration example when the duration is invalid", async () => {
    const context = makeContext({ language: "de" });

    const result = await processTempVipsChatMessage(makeEvent("!vip @gamer 9m"), context);

    expect(context.tempVips.grant).not.toHaveBeenCalled();
    const reply = result.actions[0];
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") return;
    expect(reply.text).toContain("!vip @name 30m");
  });

  it("refuses unknown Twitch logins without calling the VIP RPC", async () => {
    const context = makeContext({ lookup: () => Promise.resolve(null) });

    const result = await processTempVipsChatMessage(makeEvent("!vip @missing 30m"), context);

    expect(context.tempVips.grant).not.toHaveBeenCalled();
    const reply = result.actions[0];
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") return;
    expect(reply.text).toContain("couldn't find");
  });

  it.each<[string, typeof target]>([
    ["the broadcaster", { ...target, userId: "channel-1" }],
    ["the bot", { ...target, userId: "bot-user" }],
  ])("refuses %s as a temporary VIP target", async (_description, protectedUser) => {
    const context = makeContext({ lookup: () => Promise.resolve(protectedUser) });

    const result = await processTempVipsChatMessage(makeEvent("!vip @gamer 30m"), context);

    expect(context.tempVips.grant).not.toHaveBeenCalled();
    const reply = result.actions[0];
    expect(reply?.kind).toBe("chat");
    if (reply?.kind !== "chat") return;
    expect(reply.text).toContain("cannot be temporary VIPs");
  });

  it("returns a read-only indeterminate dry-run row for a valid VIP command", async () => {
    const context = {
      botUserId: vi.fn(() => Promise.resolve("bot-user")),
      channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
      channelTimeZone: vi.fn(() => Promise.resolve("Europe/Berlin")),
      lookupUserByLogin: vi.fn(() => Promise.resolve(target)),
      defaultChatTarget: "source_only" as const,
    } as unknown as ModuleDryRunContext;

    const result = await dryRunTempVipsChatMessage(makeEvent("!vip @gamer 30m"), context);

    expect(result).toMatchObject<readonly Partial<DryRunEntryReport>[]> ([{
      moduleId: "temp_vips",
      outcome: "indeterminate",
      effects: [],
      templateNotes: [{ code: "template.deferred_live" }],
    }]);
    expect(context.lookupUserByLogin).toHaveBeenCalledWith("gamer");
  });

  const dryRunContextFor = (user: typeof target): ModuleDryRunContext => ({
    botUserId: vi.fn(() => Promise.resolve("bot-user")),
    channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
    channelTimeZone: vi.fn(() => Promise.resolve("Europe/Berlin")),
    lookupUserByLogin: vi.fn(() => Promise.resolve(user)),
    defaultChatTarget: "source_only" as const,
  } as unknown as ModuleDryRunContext);

  it("dry-run ignores moderator commands from viewers", async () => {
    expect(await dryRunTempVipsChatMessage(makeEvent("!vip @gamer 30m", null), dryRunContextFor(target))).toEqual([]);
    expect(await dryRunTempVipsChatMessage(makeEvent("!unvip @gamer", ["vip"]), dryRunContextFor(target))).toEqual([]);
  });

  it("dry-run previews the refusal for the broadcaster as target", async () => {
    const result = await dryRunTempVipsChatMessage(
      makeEvent("!vip @gamer 30m", ["broadcaster"]),
      dryRunContextFor({ ...target, userId: "channel-1" }),
    );

    expect(result[0]).toMatchObject({ outcome: "fires" });
    expect(result[0]?.effects[0]).toMatchObject({ kind: "chat", automated: false });
  });

  it("lets the broadcaster grant and lets everyone use !viptime", async () => {
    const context = makeContext();
    await processTempVipsChatMessage(makeEvent("!vip @gamer 30m", ["broadcaster"]), context);
    expect(context.tempVips.grant).toHaveBeenCalledTimes(1);
    await processTempVipsChatMessage(makeEvent("!viptime", null), context);
    expect(context.tempVips.list).toHaveBeenCalledTimes(1);
  });
});
