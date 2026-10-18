import { describe, expect, it } from "vitest";

import type { ModuleDryRunContext, ModuleEvent } from "../../src/modules/contract";
import { textCommandModule } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const NOW = "2026-09-19T12:00:00.000Z";
const CHANNEL_ID = "kanal-a";

const contextFor = (database: TestD1Database, overrides: Partial<ModuleDryRunContext> = {}): ModuleDryRunContext => ({
  DB: database as unknown as D1Database,
  defaultChatTarget: "source_only",
  botUserId: () => Promise.resolve("bot-1"),
  streamState: () => Promise.resolve("online"),
  channelInfo: () => Promise.resolve({ title: "", gameName: "", gameId: "", startedAt: NOW, viewerCount: 0 }),
  channelGameId: () => Promise.resolve("42"),
  channelLanguage: () => Promise.resolve("de"),
  channelTimeZone: () => Promise.resolve("Europe/Berlin"),
  readChannelVariables: async (names) => Object.fromEntries(await Promise.all(names.map(async (name) => {
    const row = await database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = ?")
      .bind(CHANNEL_ID, name).first<{ value: number }>();
    return row === null ? null : [name, row.value] as const;
  })).then((values) => values.filter((value): value is readonly [string, number] => value !== null))),
  renderTemplate: (text, values) => Promise.resolve({
    text: text.replaceAll("{user}", String(values.target ?? "")),
    diagnostics: [],
  }),
  followedAt: () => Promise.resolve("unavailable"),
  userCreatedAt: () => Promise.resolve(null),
  secureRandomInteger: () => 0,
  ...overrides,
});

const eventFor = (text: string, chatStatus: readonly ["viewer"] | readonly ["subscriber"] = ["viewer"]): ModuleEvent<Record<string, never>> => ({
  channelId: CHANNEL_ID,
  subscriptionType: "channel.chat.message",
  triggerId: "dry-run",
  payload: {
    message: { text },
    message_id: "dry-run",
    chatter_user_id: "synthetic:viewer_42",
    chatter_user_login: "viewer_42",
    broadcaster_user_login: CHANNEL_ID,
    source_broadcaster_user_id: CHANNEL_ID,
  },
  settings: {},
  receivedAt: NOW,
  actor: { userId: "synthetic:viewer_42", login: "viewer_42", role: null },
  chatStatus,
});

describe("text command dry-run", () => {
  it("reuses production matching and reports the alias reply and unconsumed cooldowns", async () => {
    const database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const repository = createTextCommandRepository(
      database as unknown as D1Database,
      () => ({ sql: "AND 1 = 1", values: [] }),
    );
    await repository.create({
      channelId: CHANNEL_ID,
      name: "hello",
      text: "Hello {user}",
      kind: "text",
      aliases: ["hi"],
      cooldownSeconds: 30,
      userCooldownSeconds: 60,
      responseType: "reply",
      chatTarget: "where_asked",
      now: NOW,
    }, { userId: "member-1" });

    const reports = await textCommandModule.dryRunChatMessage?.(eventFor("!hi"), contextFor(database));

    expect(reports).toEqual([{
      moduleId: "text_commands",
      entry: { kind: "text_command", id: "hello", label: "!hello" },
      outcome: "fires",
      match: { kind: "alias", token: "hi" },
      blocks: [],
      effects: [
        {
          kind: "chat",
          text: "Hello viewer_42",
          target: "where_asked",
          postsTo: "this_chat",
          reply: true,
          suppressedBy: null,
          automated: false,
        },
        { kind: "cooldown", scope: "global", seconds: 30 },
        { kind: "cooldown", scope: "user", seconds: 60 },
      ],
      templateNotes: [],
    }]);
    await expect(database.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'hello'")
      .first()).resolves.toEqual({ use_count: 0, last_used_at: null });
    database.close();
  });

  it("reports production cooldown diagnostics as a block for the matched command", async () => {
    const database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    const repository = createTextCommandRepository(
      database as unknown as D1Database,
      () => ({ sql: "AND 1 = 1", values: [] }),
    );
    await repository.create({
      channelId: CHANNEL_ID,
      name: "hello",
      text: "Hello",
      kind: "text",
      cooldownSeconds: 60,
      now: NOW,
    }, { userId: "member-1" });
    await database.prepare("UPDATE text_commands SET last_used_at = ? WHERE command_name = 'hello'")
      .bind(NOW).run();

    const reports = await textCommandModule.dryRunChatMessage?.(eventFor("!hello"), contextFor(database));

    expect(reports?.[0]).toMatchObject({
      entry: { id: "hello", label: "!hello" },
      outcome: "blocked",
      match: { kind: "command_name", token: "!hello" },
      blocks: [{ code: "text_commands.cooldown", detail: { remainingSeconds: 60 } }],
      effects: [],
    });
    await expect(database.prepare("SELECT use_count FROM text_commands WHERE command_name = 'hello'").first())
      .resolves.toEqual({ use_count: 0 });
    database.close();
  });

  it.each([
    {
      name: "tier restrictions",
      command: { minimumTier: "subscriber" as const },
      text: "!hello",
      chatStatus: ["viewer"] as const,
      expectedCode: "text_commands.permission_denied",
    },
    {
      name: "offline-only restrictions",
      command: { streamCondition: "offline" as const },
      text: "!hello",
      chatStatus: ["viewer"] as const,
      context: { streamState: () => Promise.resolve("online" as const) },
      expectedCode: "text_commands.stream_state",
    },
    {
      name: "game filters",
      command: { games: [{ id: "7", name: "Other game" }] },
      text: "!hello",
      chatStatus: ["viewer"] as const,
      context: { channelGameId: () => Promise.resolve("42") },
      expectedCode: "text_commands.game_filter",
    },
    {
      name: "invalid set-argument values",
      command: { variableAction: { name: "score", operation: "set_argument" as const, amount: 0 } },
      text: "!hello not-a-number",
      chatStatus: ["viewer"] as const,
      expectedCode: "text_commands.argument_invalid",
    },
  ])("reports production $name as a block", async ({ command, text, chatStatus, context, expectedCode }) => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 0, ?, ?)",
      ).bind(CHANNEL_ID, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      await repository.create({
        channelId: CHANNEL_ID,
        name: "hello",
        text: "Hello",
        kind: "text",
        cooldownSeconds: 0,
        now: NOW,
        ...command,
      }, { userId: "member-1" });

      const reports = await textCommandModule.dryRunChatMessage?.(eventFor(text, chatStatus), contextFor(database, context));

      expect(reports?.[0]).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: expectedCode }],
        effects: expectedCode === "text_commands.argument_invalid"
          ? [{ kind: "chat", text: "Nutzung: !so <name>", target: "source_only" }]
          : [],
      });
    } finally {
      database.close();
    }
  });

  it("reports clamped variable changes and timeout ranges without applying either effect", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, CHANNEL_ID);
      await database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 999999998, ?, ?)",
      ).bind(CHANNEL_ID, NOW, NOW).run();
      const repository = createTextCommandRepository(
        database as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      await repository.create({
        channelId: CHANNEL_ID,
        name: "score",
        text: "Score",
        kind: "text",
        cooldownSeconds: 0,
        variableAction: { name: "score", operation: "add", amount: 4 },
        now: NOW,
      }, { userId: "member-1" });
      await repository.create({
        channelId: CHANNEL_ID,
        name: "timeout",
        text: "Timeout",
        kind: "timeout",
        cooldownSeconds: 0,
        timeoutAction: { minSeconds: 20, maxSeconds: 60, fallbackText: "Fallback" },
        now: NOW,
      }, { userId: "member-1" });

      const score = await textCommandModule.dryRunChatMessage?.(eventFor("!score"), contextFor(database));
      const timeout = await textCommandModule.dryRunChatMessage?.(eventFor("!timeout"), contextFor(database));

      expect(score?.[0]?.effects).toContainEqual({ kind: "variable", name: "score", from: 999999998, to: 999999999 });
      expect(timeout?.[0]?.effects).toContainEqual({ kind: "timeout", minSeconds: 20, maxSeconds: 60, reason: "!timeout" });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 999999998 });
    } finally {
      database.close();
    }
  });

  it("matches production's missing-target usage reply and consumed cooldowns", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      await Promise.all([insertChannel(productionDatabase, CHANNEL_ID), insertChannel(dryRunDatabase, CHANNEL_ID)]);
      const productionRepository = createTextCommandRepository(
        productionDatabase as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      const dryRunRepository = createTextCommandRepository(
        dryRunDatabase as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      const command = {
        channelId: CHANNEL_ID,
        name: "shout",
        text: "Visit {target}",
        kind: "shoutout" as const,
        usageText: "Usage: !shout <name>",
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        responseType: "reply" as const,
        chatTarget: "source_only" as const,
        now: NOW,
      };
      await Promise.all([
        productionRepository.create(command, { userId: "member-1" }),
        dryRunRepository.create(command, { userId: "member-1" }),
      ]);

      const production = await processTextCommandMessage(eventFor("!shout"), productionRepository);
      const dryRun = await textCommandModule.dryRunChatMessage?.(eventFor("!shout"), contextFor(dryRunDatabase));
      const entry = dryRun?.[0];

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "chat", text: "Usage: !shout <name>" }));
      expect(entry).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: "text_commands.argument_missing" }],
        effects: [
          { kind: "chat", text: "Usage: !shout <name>", target: "source_only" },
          { kind: "cooldown", scope: "global", seconds: 30 },
          { kind: "cooldown", scope: "user", seconds: 60 },
        ],
      });
      await expect(productionDatabase.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'shout'").first())
        .resolves.toEqual({ use_count: 1, last_used_at: NOW });
      await expect(dryRunDatabase.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'shout'").first())
        .resolves.toEqual({ use_count: 0, last_used_at: null });
      await expect(dryRunDatabase.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns WHERE command_name = 'shout'").first())
        .resolves.toEqual({ count: 0 });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });

  it("matches production's invalid set-argument usage reply without consuming the command", async () => {
    const productionDatabase = new TestD1Database();
    const dryRunDatabase = new TestD1Database();
    try {
      await Promise.all([insertChannel(productionDatabase, CHANNEL_ID), insertChannel(dryRunDatabase, CHANNEL_ID)]);
      await Promise.all([productionDatabase, dryRunDatabase].map((database) => database.prepare(
        "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 7, ?, ?)",
      ).bind(CHANNEL_ID, NOW, NOW).run()));
      const productionRepository = createTextCommandRepository(
        productionDatabase as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      const dryRunRepository = createTextCommandRepository(
        dryRunDatabase as unknown as D1Database,
        () => ({ sql: "AND 1 = 1", values: [] }),
      );
      const command = {
        channelId: CHANNEL_ID,
        name: "score",
        text: "Score updated",
        kind: "text" as const,
        usageText: "Usage: !score <number>",
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        minimumTier: "everyone" as const,
        variableAction: { name: "score", operation: "set_argument" as const, amount: 0 },
        now: NOW,
      };
      await Promise.all([
        productionRepository.create(command, { userId: "member-1" }),
        dryRunRepository.create(command, { userId: "member-1" }),
      ]);

      const production = await processTextCommandMessage(eventFor("!score nope"), productionRepository);
      const dryRun = await textCommandModule.dryRunChatMessage?.(eventFor("!score nope"), contextFor(dryRunDatabase));
      const entry = dryRun?.[0];

      expect(production.actions).toContainEqual(expect.objectContaining({ kind: "chat", text: "Usage: !score <number>" }));
      expect(entry).toMatchObject({
        outcome: "blocked",
        blocks: [{ code: "text_commands.argument_invalid" }],
        effects: [{ kind: "chat", text: "Usage: !score <number>", target: "source_only" }],
      });
      await expect(productionDatabase.prepare("SELECT use_count, last_used_at FROM text_commands WHERE command_name = 'score'").first())
        .resolves.toEqual({ use_count: 0, last_used_at: null });
      await expect(productionDatabase.prepare("SELECT COUNT(*) AS count FROM text_command_user_cooldowns WHERE command_name = 'score'").first())
        .resolves.toEqual({ count: 0 });
    } finally {
      productionDatabase.close();
      dryRunDatabase.close();
    }
  });
});
