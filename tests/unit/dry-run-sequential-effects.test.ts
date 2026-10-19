import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { votekickModule } from "../../src/modules/votekick";
import { faqModule } from "../../src/modules/faq";
import { textCommandModule } from "../../src/modules/text_commands";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { createVotekickRepository } from "../../src/modules/votekick/adapters/d1";
import { dryRunChatMessage } from "../../src/worker/dry-run";
import type { ModuleDryRunBallotSnapshot } from "../../src/modules/contract";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "sequential-effects-channel";
const NOW = "2026-10-19T12:00:00.000Z";
const KEY_RING = JSON.stringify({
  active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(5)).toString("base64url") },
  retired: [],
});

const encryptedToken = (token: string) => encryptJson({ token }, parseKeyRing(KEY_RING));

const seedIdentity = async (database: TestD1Database): Promise<void> => {
  await upsertBotIdentity(database as unknown as D1Database, {
    id: 1,
    userId: "bot-user",
    login: "brobot",
    scopesJson: "[]",
    accessTokenCiphertext: await encryptedToken("bot-token"),
    refreshTokenCiphertext: await encryptedToken("bot-refresh-token"),
    expiresAt: "2099-10-19T12:00:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertAppAccessToken(
    database,
    await encryptedToken("app-token"),
    "2099-10-19T12:00:00.000Z",
    NOW,
    NOW,
  );
  await insertLoginIdentityAndSession(database, CHANNEL_ID, ["moderation:read"]);
  await database.prepare(
    "UPDATE twitch_login_identity SET access_token_ciphertext = ?, refresh_token_ciphertext = ? WHERE user_id = ?",
  ).bind(await encryptedToken("broadcaster-token"), await encryptedToken("broadcaster-refresh-token"), CHANNEL_ID).run();
};

interface ScenarioOptions {
  textCommandEnabled?: boolean;
  paused?: boolean;
  muted?: boolean;
  textCommandText?: string;
  startText?: string;
  passText?: string;
  commandHasVariableAction?: boolean;
  ballotSnapshot?: ModuleDryRunBallotSnapshot;
}

const createScenario = async (withFaq: boolean, options: ScenarioOptions = {}) => {
  const database = new TestD1Database();
  await insertChannel(database, CHANNEL_ID);
  await seedIdentity(database);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'text_commands', ?, '{}')",
  ).bind(CHANNEL_ID, options.textCommandEnabled === false ? 0 : 1).run();
  if (withFaq) {
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'faq', 1, '{}')",
    ).bind(CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO faq_entries
        (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, minimum_tier,
         cooldown_seconds, user_cooldown_seconds, games_json, chat_target, use_channel_default_target,
         sort_order, revision, last_used_at, created_at, updated_at)
       VALUES ('faq-votekick', ?, 'Votekick FAQ', 1, 'keywords', ?, 'Score {var.score}', 'everyone',
         30, 0, '[]', 'where_asked', 1, 0, 1, NULL, ?, ?)`,
    ).bind(CHANNEL_ID, JSON.stringify({ type: "keywords", patterns: ["votekick"] }), NOW, NOW).run();
  }
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'votekick', 1, ?)",
  ).bind(CHANNEL_ID, JSON.stringify({
    ...DEFAULT_VOTEKICK_SETTINGS,
    starterMinRole: "vip",
    minNetVotes: 3,
    percent: 5,
    startText: options.startText ?? "Kick start, score {var.score}",
    ...(options.passText === undefined ? {} : { passText: options.passText }),
  })).run();
  if (options.paused === true || options.muted === true) {
    await database.prepare(
      "INSERT INTO channel_controls (channel_id, muted, paused, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(CHANNEL_ID, options.muted === true ? 1 : 0, options.paused === true ? 1 : 0, NOW).run();
  }
  await database.prepare(
    "INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at) VALUES (?, 'score', 41, ?, ?)",
  ).bind(CHANNEL_ID, NOW, NOW).run();

  const commands = createTextCommandRepository(
    database as unknown as D1Database,
    () => ({ sql: "AND 1 = 1", values: [] }),
  );
  await commands.create({
    channelId: CHANNEL_ID,
    name: "votekick",
    text: options.textCommandText ?? "Score {var.score}",
    kind: "text",
    cooldownSeconds: 0,
    ...(options.commandHasVariableAction === false ? {} : { variableAction: { name: "score", operation: "add" as const, amount: 1 } }),
    now: NOW,
  }, { userId: "operator-user" });

  const targetActivity = {
    firstSeenAt: "2026-10-19T11:59:00.000Z",
    lastSeenAt: "2026-10-19T11:59:00.000Z",
  };
  const channelObject = {
    getActiveChatterCountSnapshot: vi.fn().mockResolvedValue(1),
    getActiveChatterSnapshot: vi.fn((userId: string) => Promise.resolve(userId === "target-user" ? targetActivity : null)),
    readBallotDryRunSnapshot: vi.fn().mockResolvedValue(options.ballotSnapshot ?? null),
    hasOpenBallotSnapshot: vi.fn().mockResolvedValue(false),
  };
  const env = {
    DB: database as unknown as D1Database,
    PUBLIC_ORIGIN: "https://brobot.example",
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: KEY_RING,
    SESSION_ENCRYPTION_KEYS: KEY_RING,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => channelObject,
    } as unknown as Env["CHANNEL"],
  } as Env;
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/helix/users") {
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "target-user", login: "target", display_name: "target" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    if (url.pathname === "/helix/moderation/moderators") {
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    throw new Error(`Unexpected Twitch request: ${url.pathname}`);
  });

  return { database, env, fetcher };
};

const seedGreetingTextBlock = async (database: TestD1Database): Promise<void> => {
  await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES (?, 1, ?)")
    .bind(CHANNEL_ID, NOW).run();
  await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, 'social', ?, ?)")
    .bind(CHANNEL_ID, NOW, NOW).run();
  await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, 'greeting', 'social', 1, ?, ?)")
    .bind(CHANNEL_ID, NOW, NOW).run();
  await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json, last_chosen_index) VALUES (?, 'greeting', 'default', 0, '{}', '[\"Hello\",\"Welcome\"]', 0)")
    .bind(CHANNEL_ID).run();
};

const seedRunningVotekick = async (database: TestD1Database): Promise<void> => {
  await createVotekickRepository(database as unknown as D1Database).admit(CHANNEL_ID, {
    id: "running-votekick",
    targetUserId: "target-user",
    targetLogin: "target",
    initiatorUserId: "starter-user",
    threshold: 3,
    yesVotes: 0,
    ballotRevision: 1,
    startedAt: "2026-10-19T11:59:00.000Z",
    endsAt: "2026-10-19T12:01:00.000Z",
  }, NOW, 0, 0);
};

const request = {
  text: "!votekick target",
  sender: { login: "viewer_42", statuses: ["vip"] as const },
  streamState: "online" as const,
  game: null,
  sharedChat: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("dry-run sequential module effects", () => {
  it("does not carry text-block choices forward from a disabled module", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, {
      textCommandEnabled: false,
      textCommandText: "{text.greeting}",
      startText: "Kick {text.greeting}",
    });
    try {
      await seedGreetingTextBlock(database);
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, votekickModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(commandEntry?.blocks.map(({ code }) => code)).toContain("host.module_disabled");
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick Welcome" }));
      await expect(database.prepare("SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'greeting'").first())
        .resolves.toEqual({ last_chosen_index: 0 });
    } finally {
      database.close();
    }
  });

  it("does not carry text-block choices from a paused module into a pause-safe module", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, {
      paused: true,
      textCommandText: "{text.greeting}",
      startText: "Kick {text.greeting}",
    });
    const pauseSafeVotekickModule: typeof votekickModule = {
      ...votekickModule,
      pauseSafeEventSubTypes: ["channel.chat.message"],
    };
    try {
      await seedGreetingTextBlock(database);
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, pauseSafeVotekickModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(commandEntry?.blocks.map(({ code }) => code)).toContain("host.channel_paused");
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick Welcome" }));
      await expect(database.prepare("SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'greeting'").first())
        .resolves.toEqual({ last_chosen_index: 0 });
    } finally {
      database.close();
    }
  });

  it("projects a committed variable increment across modules when mute suppresses chat delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, { muted: true });
    try {
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, votekickModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(commandEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", suppressedBy: "channel_muted" }));
      expect(commandEntry?.effects).toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({
        kind: "chat",
        text: "Kick start, score 42",
        suppressedBy: "channel_muted",
      }));
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 41 });
    } finally {
      database.close();
    }
  });

  it("keeps rendered text-block choices when muted FAQ delivery releases its claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(true, { muted: true });
    const blockProbeModule: typeof textCommandModule = {
      ...textCommandModule,
      id: "state_probe",
      templateContext: "event",
      dryRunChatMessage: async (_event, context) => {
        const rendered = await context.renderTemplate("Probe {text.greeting}", {}, undefined, "chat");
        return [{
          moduleId: "state_probe",
          entry: { kind: "faq_entry", id: "state-probe", label: "State probe" },
          outcome: "fires",
          match: { kind: "keyword", pattern: "votekick" },
          blocks: [],
          effects: [{
            kind: "chat",
            text: rendered.text,
            target: "source_only",
            postsTo: "this_chat",
            reply: false,
            suppressedBy: null,
            automated: false,
          }],
          templateNotes: rendered.diagnostics,
        }];
      },
    };
    try {
      await seedGreetingTextBlock(database);
      await database.prepare("UPDATE faq_entries SET answer_text = '{text.greeting}' WHERE faq_id = 'faq-votekick'")
        .run();
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'state_probe', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      const result = await dryRunChatMessage(
        env,
        CHANNEL_ID,
        { ...request, text: "votekick" },
        fetcher,
        [faqModule, blockProbeModule],
      );
      const faqEntry = result.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0];
      const probeEntry = result.modules.find(({ moduleId }) => moduleId === "state_probe")?.entries[0];

      expect(faqEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Welcome", suppressedBy: "channel_muted" }));
      expect(faqEntry?.effects.some(({ kind }) => kind === "cooldown")).toBe(false);
      expect(probeEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Probe Hello" }));
    } finally {
      database.close();
    }
  });

  it("uses the FAQ render choice for a later passing votekick even when its cooldown claim fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const ballotSnapshot: ModuleDryRunBallotSnapshot = {
      counts: [3, 0],
      revision: 2,
      expiresAt: Date.parse("2026-10-19T12:01:00.000Z"),
      isActive: true,
    };
    const { database, env, fetcher } = await createScenario(true, {
      passText: "Pass {text.greeting}",
      ballotSnapshot,
    });
    try {
      await seedGreetingTextBlock(database);
      await seedRunningVotekick(database);
      await database.prepare("UPDATE faq_entries SET answer_text = '{text.greeting}', last_used_at = ? WHERE faq_id = 'faq-votekick'")
        .bind(NOW).run();
      const result = await dryRunChatMessage(
        env,
        CHANNEL_ID,
        { ...request, text: "votekick" },
        fetcher,
        [faqModule, votekickModule],
      );
      const faqEntry = result.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(faqEntry).toMatchObject({ outcome: "blocked", blocks: [{ code: "faq.cooldown" }] });
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Pass Hello" }));
      await expect(database.prepare("SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'greeting'").first())
        .resolves.toEqual({ last_chosen_index: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps muted command render choices without variable or cooldown effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, {
      muted: true,
      textCommandText: "Command {text.greeting}",
      commandHasVariableAction: false,
    });
    const blockProbeModule: typeof textCommandModule = {
      ...textCommandModule,
      id: "state_probe",
      templateContext: "event",
      dryRunChatMessage: async (_event, context) => {
        const rendered = await context.renderTemplate("Probe {text.greeting}", {}, undefined, "chat");
        return [{
          moduleId: "state_probe",
          entry: { kind: "faq_entry", id: "state-probe", label: "State probe" },
          outcome: "fires",
          match: { kind: "keyword", pattern: "votekick" },
          blocks: [],
          effects: [{
            kind: "chat",
            text: rendered.text,
            target: "source_only",
            postsTo: "this_chat",
            reply: false,
            suppressedBy: null,
            automated: false,
          }],
          templateNotes: rendered.diagnostics,
        }];
      },
    };
    try {
      await seedGreetingTextBlock(database);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'state_probe', 1, '{}')",
      ).bind(CHANNEL_ID).run();
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, blockProbeModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const probeEntry = result.modules.find(({ moduleId }) => moduleId === "state_probe")?.entries[0];

      expect(commandEntry?.effects).toContainEqual(expect.objectContaining({
        kind: "chat",
        text: "Command Welcome",
        suppressedBy: "channel_muted",
      }));
      expect(commandEntry?.effects.some(({ kind }) => kind === "variable" || kind === "cooldown")).toBe(false);
      expect(probeEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Probe Hello" }));
      await expect(database.prepare("SELECT last_chosen_index FROM text_block_variants WHERE block_name = 'greeting'").first())
        .resolves.toEqual({ last_chosen_index: 0 });
    } finally {
      database.close();
    }
  });

  it("renders a later votekick reply with the earlier text command's simulated variable change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false);
    try {
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, votekickModule]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const votekickEntry = result.modules.find(({ moduleId }) => moduleId === "votekick")?.entries[0];

      expect(commandEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Score 42" }));
      expect(commandEntry?.effects).toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(votekickEntry?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick start, score 42" }));
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 41 });
      await expect(database.prepare("SELECT COUNT(*) AS count FROM votekicks WHERE channel_id = ?")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("filters votekick reports after projecting the preceding text command variable change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, { startText: "Kick score {var.score}" });
    const productionOrder = [textCommandModule, votekickModule];
    try {
      const unfiltered = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, productionOrder);
      const filtered = await dryRunChatMessage(
        env,
        CHANNEL_ID,
        { ...request, only: { moduleId: "votekick" } },
        fetcher,
        productionOrder,
      );
      const expected = unfiltered.modules.filter(({ moduleId }) => moduleId === "votekick");

      expect(unfiltered.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0]?.effects)
        .toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(expected[0]?.entries[0]?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick score 42" }));
      expect(filtered.modules).toEqual(expected);
    } finally {
      database.close();
    }
  });

  it("filters votekick reports after committing the preceding text-block choice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(false, {
      textCommandText: "Command {text.greeting}",
      commandHasVariableAction: false,
      startText: "Kick {text.greeting}",
    });
    const productionOrder = [textCommandModule, votekickModule];
    try {
      await seedGreetingTextBlock(database);
      const unfiltered = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, productionOrder);
      const filtered = await dryRunChatMessage(
        env,
        CHANNEL_ID,
        { ...request, only: { moduleId: "votekick" } },
        fetcher,
        productionOrder,
      );
      const expected = unfiltered.modules.filter(({ moduleId }) => moduleId === "votekick");

      expect(unfiltered.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0]?.effects)
        .toContainEqual(expect.objectContaining({ kind: "chat", text: "Command Welcome" }));
      expect(expected[0]?.entries[0]?.effects).toContainEqual(expect.objectContaining({ kind: "chat", text: "Kick Hello" }));
      expect(filtered.modules).toEqual(expected);
    } finally {
      database.close();
    }
  });

  it("filters FAQ entries after evaluating the FAQ against the preceding variable projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(true);
    const faqReadScores: number[] = [];
    const faqWithProjectionProbe: typeof faqModule = {
      ...faqModule,
      dryRunChatMessage: async (event, context) => {
        faqReadScores.push((await context.readChannelVariables(["score"])).score ?? -1);
        return await faqModule.dryRunChatMessage?.(event, context) ?? [];
      },
    };
    const productionOrder = [textCommandModule, faqWithProjectionProbe, votekickModule];
    try {
      const unfiltered = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, productionOrder);
      const filtered = await dryRunChatMessage(
        env,
        CHANNEL_ID,
        { ...request, only: { moduleId: "faq", entryId: "faq-votekick" } },
        fetcher,
        productionOrder,
      );
      const expected = unfiltered.modules
        .filter(({ moduleId }) => moduleId === "faq")
        .map((module) => ({
          ...module,
          entries: module.entries.filter(({ entry }) => entry.id === "faq-votekick"),
        }));

      expect(faqReadScores).toEqual([42, 42]);
      expect(expected[0]?.entries.map(({ entry }) => entry.id)).toContain("faq-votekick");
      expect(filtered.modules).toEqual(expected);
    } finally {
      database.close();
    }
  });

  it("exposes the earlier text-command projection to the FAQ adapter for the same command message", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { database, env, fetcher } = await createScenario(true);
    let faqReadScore: number | undefined;
    const faqWithReadProbe: typeof faqModule = {
      ...faqModule,
      dryRunChatMessage: async (event, context) => {
        faqReadScore = (await context.readChannelVariables(["score"])).score;
        return await faqModule.dryRunChatMessage?.(event, context) ?? [];
      },
    };
    try {
      const result = await dryRunChatMessage(env, CHANNEL_ID, request, fetcher, [textCommandModule, faqWithReadProbe]);
      const commandEntry = result.modules.find(({ moduleId }) => moduleId === "text_commands")?.entries[0];
      const faqEntry = result.modules.find(({ moduleId }) => moduleId === "faq")?.entries[0];

      expect(commandEntry?.effects).toContainEqual({ kind: "variable", name: "score", from: 41, to: 42 });
      expect(faqReadScore).toBe(42);
      expect(faqEntry).toMatchObject({ outcome: "blocked", blocks: [{ code: "faq.command_prefix" }] });
      await expect(database.prepare("SELECT value FROM channel_variables WHERE channel_id = ? AND name = 'score'")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ value: 41 });
    } finally {
      database.close();
    }
  });
});
