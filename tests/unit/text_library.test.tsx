import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleTemplateExpansionContext } from "../../src/modules/contract";
import type { ModuleEvent } from "../../src/modules/contract";
import { textLibraryModule } from "../../src/modules/text_library";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import type { TextBlockConditions, TextBlockVariant } from "../../src/modules/text_library/contracts";
import { createTextBlockTemplateExpander } from "../../src/modules/text_library/adapters/template-expander";
import { createTextBlockRepository } from "../../src/modules/text_library/adapters/d1";
import { createTextLibraryService } from "../../src/modules/text_library/service";
import { firstMatchingTextBlockVariant, textBlockConditionsMatch } from "../../src/modules/text_library/domain";
import TextLibraryPanel from "../../src/modules/text_library/panel/index";
import { createTemplateRenderer, type TemplateResolverSources } from "../../src/worker/template-resolver";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "esembe";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ACTOR = { userId: "fictional-manager", sessionId: "fictional-session" };
const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });

const variant = (id: string, text: string, conditions: TextBlockConditions = {}): TextBlockVariant => ({
  id,
  conditions,
  texts: [text],
});

describe("text library", () => {
  let database: TestD1Database;
  let repository: ReturnType<typeof createTextBlockRepository>;
  let service: ReturnType<typeof createTextLibraryService>;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    repository = createTextBlockRepository(database as unknown as D1Database, authorize);
    service = createTextLibraryService(repository);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    database.close();
  });

  const createBlock = async (name: string, variants: readonly TextBlockVariant[]) => {
    const snapshot = await service.list(CHANNEL_ID);
    return service.create({
      channelId: CHANNEL_ID,
      name,
      categoryId: "social",
      games: [],
      variants,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, ACTOR);
  };

  it("keeps library reads read-only while supplying default categories", async () => {
    const snapshot = await service.list(CHANNEL_ID);

    expect(snapshot.categories.map((category) => category.id)).toEqual(["social", "info", "faq", "game", "fun"]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_settings").first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_categories").first()).resolves.toEqual({ count: 0 });
  });

  it("resolves live and offline variants in command and event templates", async () => {
    await expect(createBlock("greeting", [
      variant("live", "Hello live", { stream: "online" }),
      variant("offline", "Hello offline", { stream: "offline" }),
      variant("default", "Hello", {}),
    ])).resolves.toMatchObject({ ok: true });

    const expand = textLibraryModule.expandTemplateVariables;
    if (expand === undefined) throw new Error("Text library does not register its template expansion.");
    const createRenderer = (templateContext: "chat_command" | "event", isLive: boolean, event: ModuleEvent) => {
      const sources: TemplateResolverSources = {
        streamState: () => Promise.resolve(isLive ? "online" : "offline"),
        channelDetails: () => Promise.resolve(null),
        streamDetails: () => Promise.resolve(null),
        followedAt: () => Promise.resolve("unavailable"),
        followerTotal: () => Promise.resolve(null),
        chattersTotal: () => Promise.resolve(null),
        userCreatedAt: () => Promise.resolve(null),
        channelLanguage: () => Promise.resolve("en"),
        readChannelVariables: () => Promise.resolve({}),
        expandModuleTemplateVariables: async (text, knownVariables) => {
          return expand({
            DB: database as unknown as D1Database,
            channelId: CHANNEL_ID,
            text,
            knownVariables,
            templateContext,
            chatStatus: event.chatStatus,
            streamState: sources.streamState,
            channelInfo: () => Promise.resolve(null),
            now: NOW,
          } satisfies ModuleTemplateExpansionContext);
        },
        now: () => NOW,
      };
      return createTemplateRenderer(event, templateContext, [], sources);
    };
    const commandEvent: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-command-trigger",
      payload: {
        message: { text: "!guide" },
        chatter_user_id: "fictional-user",
        chatter_user_login: "esembe",
        broadcaster_user_login: CHANNEL_ID,
      },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: null },
      chatStatus: ["viewer"],
    };
    const commands = createTextCommandRepository(database as unknown as D1Database, authorize);
    await commands.create({ channelId: CHANNEL_ID, name: "guide", text: "{greeting}", kind: "text", cooldownSeconds: 0, now: new Date(NOW).toISOString() }, ACTOR);
    const runCommand = async (isLive: boolean): Promise<string | undefined> => {
      const result = await processTextCommandMessage(commandEvent, commands, {
        renderTemplate: createRenderer("chat_command", isLive, commandEvent),
      });
      return result.actions.find((action) => action.kind === "chat")?.text;
    };
    await expect(runCommand(true)).resolves.toBe("Hello live");
    await expect(runCommand(false)).resolves.toBe("Hello offline");

    const event: ModuleEvent = { ...commandEvent, subscriptionType: "channel.raid", payload: {}, actor: null, chatStatus: null };
    await expect(createRenderer("event", true, event)("{greeting}", {})).resolves.toMatchObject({ text: "Hello live" });
    await expect(createRenderer("event", false, event)("{greeting}", {})).resolves.toMatchObject({ text: "Hello offline" });
  });

  it("rejects cycles and nesting deeper than three blocks when saving", async () => {
    await expect(createBlock("cycle_a", [variant("default", "{cycle_b}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("cycle_b", [variant("default", "{cycle_a}")])).resolves.toMatchObject({
      ok: false,
      reason: "reference_cycle",
      path: ["cycle_a", "cycle_b", "cycle_a"],
    });

    await expect(createBlock("root", [variant("default", "{middle}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("middle", [variant("default", "{leaf}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("leaf", [variant("default", "done")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("too_deep", [variant("default", "{root}")])).resolves.toMatchObject({
      ok: false,
      reason: "reference_depth_exceeded",
    });
  });

  it("reports direct and nested uses supplied by generic module contracts", async () => {
    await expect(createBlock("answer", [variant("default", "{detail}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("detail", [variant("default", "A reusable detail")])).resolves.toMatchObject({ ok: true });
    const snapshot = await service.list(CHANNEL_ID, [{ text: "!faq {answer}", kind: "command", label: "!faq" }]);
    expect(snapshot.usages.answer).toEqual([{ kind: "command", label: "!faq" }]);
    expect(snapshot.usages.detail).toEqual([{ kind: "command", label: "!faq" }]);
  });

  it("silently ignores a text command when its Twitch game filter does not match", async () => {
    const commands = createTextCommandRepository(database as unknown as D1Database, authorize);
    await commands.create({
      channelId: CHANNEL_ID,
      name: "guide",
      text: "Guide text",
      kind: "text",
      cooldownSeconds: 0,
      games: [{ id: "42", name: "Example Game" }],
      now: new Date(NOW).toISOString(),
    }, ACTOR);
    const result = await processTextCommandMessage({
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-command-trigger",
      payload: {
        message: { text: "!guide" },
        chatter_user_id: "fictional-user",
        chatter_user_login: "esembe",
        broadcaster_user_login: CHANNEL_ID,
      },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: null },
      chatStatus: ["viewer"],
    }, commands, {
      channelInfo: () => Promise.resolve({ title: "", gameName: "Other Game", gameId: "77", startedAt: null, viewerCount: 0 }),
      renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
    });
    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.game_filter");
  });

  it("keeps role and time conditions tied to command context and channel time", () => {
    const moderatorCondition = { minimumTier: "moderator" as const };
    const state = {
      streamState: "online" as const,
      game: { id: "42", name: "Example Game" },
      chatStatus: ["vip"] as const,
      commandContext: true,
      timeZone: "Europe/Berlin",
      now: NOW,
    };
    expect(textBlockConditionsMatch(moderatorCondition, state)).toBe(false);
    expect(textBlockConditionsMatch(moderatorCondition, { ...state, chatStatus: ["moderator"] })).toBe(true);
    expect(textBlockConditionsMatch(moderatorCondition, { ...state, commandContext: false })).toBe(false);
    expect(firstMatchingTextBlockVariant([
      variant("weekend", "Weekend", { weekdays: [6], timeWindow: { start: "13:00", end: "15:00" } }),
      variant("default", "Anytime"),
    ], { ...state, chatStatus: null, commandContext: false })).toMatchObject({ id: "weekend" });
  });

  it("renders bilingual input-dependent fallbacks outside command contexts", async () => {
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-input-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };
    const sourcesFor = (language: "de" | "en"): TemplateResolverSources => ({
      streamState: () => Promise.resolve("offline"),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve("unavailable"),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve(language),
      readChannelVariables: () => Promise.resolve({}),
      now: () => NOW,
    });
    const inputVariable = {
      name: "convert",
      contexts: ["chat_command"],
      unavailableContextText: "command_input_error",
      sample: "12",
      maxLength: 12,
    } as const;
    const renderer = createTemplateRenderer(event, "event", [inputVariable], sourcesFor("en"));
    const germanRenderer = createTemplateRenderer(event, "event", [inputVariable], sourcesFor("de"));

    await expect(renderer("{args}", {})).resolves.toMatchObject({ text: "Only available in chat commands" });
    await expect(renderer("{convert}", {})).resolves.toMatchObject({ text: "This input is only available in chat commands" });
    await expect(germanRenderer("{args}", {})).resolves.toMatchObject({ text: "Nur in Chatbefehlen verfügbar" });
    await expect(germanRenderer("{convert}", {})).resolves.toMatchObject({ text: "Diese Eingabe ist nur in Chatbefehlen verfügbar" });
  });

  it("does not repeat a random text directly and caps resolved output at 500 characters", async () => {
    await expect(createBlock("random_line", [{ id: "default", conditions: {}, texts: ["first", "second"] }]))
      .resolves.toMatchObject({ ok: true });
    const renderRandom = async (): Promise<string> => {
      const expansion = createTextBlockTemplateExpander(database as unknown as D1Database, CHANNEL_ID, {
        templateContext: "event",
        chatStatus: null,
        streamState: () => Promise.resolve("offline"),
        currentGame: () => Promise.resolve(null),
        now: NOW,
      });
      return (await expansion("{random_line}", new Set())).text;
    };
    const results = await Promise.all(Array.from({ length: 8 }, renderRandom));
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index]).not.toBe(results[index - 1]);
    }

    await expect(createBlock("long_line", [variant("default", "x".repeat(400) + "{long_child}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("long_child", [variant("default", "y".repeat(200))])).resolves.toMatchObject({ ok: true });
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };
    const sources: TemplateResolverSources = {
      streamState: () => Promise.resolve("offline"),
      channelDetails: () => Promise.resolve(null),
      streamDetails: () => Promise.resolve(null),
      followedAt: () => Promise.resolve("unavailable"),
      followerTotal: () => Promise.resolve(null),
      chattersTotal: () => Promise.resolve(null),
      userCreatedAt: () => Promise.resolve(null),
      channelLanguage: () => Promise.resolve("en"),
      readChannelVariables: () => Promise.resolve({}),
      expandModuleTemplateVariables: (text, knownVariables) => {
        const expand = textLibraryModule.expandTemplateVariables;
        if (expand === undefined) throw new Error("Text library does not register its template expansion.");
        return expand({
          DB: database as unknown as D1Database,
          channelId: CHANNEL_ID,
          text,
          knownVariables,
          templateContext: "event",
          chatStatus: null,
          streamState: () => Promise.resolve("offline"),
          channelInfo: () => Promise.resolve(null),
          now: NOW,
        });
      },
      now: () => NOW,
    };
    const longResult = await createTemplateRenderer(event, "event", [], sources)("{long_line}", {});
    expect(longResult.text).toHaveLength(500);
    expect(longResult.text.endsWith("…")).toBe(true);
  });

  it("measures a three-block render with ten conditional variants under the 10 ms CPU budget", async () => {
    const currentGame = { id: "77", name: "Example Game" };
    const conditionalVariants = (nestedName: string | null): TextBlockVariant[] => [
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `conditional_${String(index)}`,
        conditions: {
          stream: "offline" as const,
          game: { mode: "is" as const, game: currentGame },
          minimumTier: "broadcaster" as const,
          timeWindow: { start: "00:00", end: "00:01" },
        },
        texts: Array.from({ length: 10 }, () => nestedName === null ? "leaf text" : `{${nestedName}}`),
      })),
      { id: "default", conditions: {}, texts: Array.from({ length: 10 }, () => nestedName === null ? "leaf text" : `{${nestedName}}`) },
    ];
    await expect(createBlock("leaf", conditionalVariants(null))).resolves.toMatchObject({ ok: true });
    await expect(createBlock("middle", conditionalVariants("leaf"))).resolves.toMatchObject({ ok: true });
    await expect(createBlock("top", conditionalVariants("middle"))).resolves.toMatchObject({ ok: true });

    const expand = createTextBlockTemplateExpander(database as unknown as D1Database, CHANNEL_ID, {
      templateContext: "chat_command",
      chatStatus: ["broadcaster"],
      streamState: () => Promise.resolve("offline"),
      currentGame: () => Promise.resolve(currentGame),
      now: NOW,
    });
    const durations: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now();
      await expand("{top}", new Set());
      durations.push(performance.now() - start);
    }
    const averageMs = durations.reduce((total, duration) => total + duration, 0) / durations.length;
    const maximumMs = Math.max(...durations);
    console.info(`Text library worst-case local render: ${averageMs.toFixed(3)} ms average, ${maximumMs.toFixed(3)} ms maximum`);
    expect(maximumMs).toBeLessThan(10);
  });

  it("shows operators the library as read-only with a reason", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      blocks: [],
      categories: [],
      settings: { timeZone: "Europe/Berlin", revision: 1, graphRevision: 1, updatedAt: new Date(NOW).toISOString() },
      usages: {},
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage={false} /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Text blocks" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Only broadcasters and managers can change text blocks and categories.");
    expect(screen.queryByRole("button", { name: "Add text block" })).not.toBeInTheDocument();
  });
});
