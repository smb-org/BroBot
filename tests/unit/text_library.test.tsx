import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent } from "../../src/modules/contract";
import { textLibraryModule } from "../../src/modules/text_library";
import { adsModule } from "../../src/modules/ads";
import { raidModule } from "../../src/modules/raid";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import type { TextBlockConditions, TextBlockVariant } from "../../src/modules/text_library/contracts";
import { createTextBlockRepository } from "../../src/modules/text_library/adapters/d1";
import { createTextLibraryService } from "../../src/modules/text_library/service";
import { panelRouter } from "../../src/worker/panel/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { firstMatchingTextBlockVariant, textBlockConditionsMatch } from "../../src/modules/text_library/domain";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import TextLibraryPanel from "../../src/modules/text_library/panel/index";
import { textLibraryTexts } from "../../src/modules/text_library/panel/locale";
import { createTemplateRenderer, type TemplateResolverSources, type TemplateValueProvider } from "../../src/worker/template-resolver";
import { truncateChatText } from "../../src/worker/chat";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../../src/modules/contract";
import { insertChannel, insertLoginIdentityAndSession, insertMember, jsonResponse, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "esembe";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ACTOR = { userId: "fictional-manager", sessionId: "fictional-session" };
const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });
const TEST_SESSION_KEYS = JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] });
const TEST_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] });

const variant = (id: string, text: string, conditions: TextBlockConditions = {}): TextBlockVariant => ({
  id,
  conditions,
  texts: [text],
});

const stubTextLibraryPanelApi = (library: unknown): void => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
    if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
    if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
    if (url.pathname.endsWith("/template-preview")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: unknown } : {};
      return Promise.resolve(jsonResponse({ text: typeof body.text === "string" ? body.text : "", diagnostics: [] }));
    }
    return Promise.resolve(jsonResponse(library));
  }));
};

describe("text library", () => {
  let database: TestD1Database;
  let repository: ReturnType<typeof createTextBlockRepository>;
  let service: ReturnType<typeof createTextLibraryService>;
  const initialWindowWidth = window.innerWidth;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    repository = createTextBlockRepository(database as unknown as D1Database, authorize);
    service = createTextLibraryService(repository);
  });

  it("declares a bilingual Channel page without an always-active switch", () => {
    expect(textLibraryModule.navigationEntries?.[0]).toMatchObject({
      id: "texts",
      group: "channel",
      showMainSwitch: false,
      iconKind: "texts",
      label: { de: "Texte", en: "Texts" },
    });
    expect(textLibraryTexts("de").allCategories).toBe("Alle Kategorien");
    expect(textLibraryTexts("en").allCategories).toBe("All categories");
    expect(textLibraryTexts("de").variantsCount(1)).toBe("1 Variante");
    expect(textLibraryTexts("en").variantsCount(1)).toBe("1 variant");
    expect(textLibraryTexts("de").usesCount(1)).toBe("1 Verwendung");
    expect(textLibraryTexts("en").usesCount(2)).toBe("2 uses");
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWindowWidth });
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
    }, ACTOR, snapshot);
  };

  const resolveBlockValues = textLibraryModule.resolveTemplateValues;
  if (resolveBlockValues === undefined) throw new Error("Text library template value provider is required.");

  const blockProvider = async (): Promise<TemplateValueProvider> => ({
    moduleId: textLibraryModule.id,
    templateVariableNamespace: "text_blocks",
    variables: await textLibraryModule.templateVariables?.(database as unknown as D1Database, CHANNEL_ID) ?? [],
    resolveTemplateValues: resolveBlockValues,
  });

  const sourcesFor = async (
    overrides: Partial<TemplateResolverSources> = {},
  ): Promise<TemplateResolverSources> => ({
    DB: database as unknown as D1Database,
    channelInfo: () => Promise.resolve(null),
    channelGameId: () => Promise.resolve(null),
    channelTimeZone: () => Promise.resolve(DEFAULT_CHANNEL_TIME_ZONE),
    templateValueProviders: [await blockProvider()],
    streamState: () => Promise.resolve("offline"),
    channelDetails: () => Promise.resolve(null),
    streamDetails: () => Promise.resolve(null),
    followedAt: () => Promise.resolve("unavailable"),
    followerTotal: () => Promise.resolve(null),
    chattersTotal: () => Promise.resolve(null),
    userCreatedAt: () => Promise.resolve(null),
    channelLanguage: () => Promise.resolve("en"),
    readChannelVariables: () => Promise.resolve({}),
    now: () => NOW,
    ...overrides,
  });

  const renderWithBlocks = async (
    text: string,
    event: ModuleEvent,
    templateContext: "chat_command" | "event",
    overrides: Partial<TemplateResolverSources> = {},
    mode: "chat" | "preview" | "overlay" = "chat",
  ) => createTemplateRenderer(event, templateContext, [], await sourcesFor(overrides))(text, {}, undefined, mode);

  it("keeps library reads read-only while supplying default categories", async () => {
    const snapshot = await service.list(CHANNEL_ID);

    expect(snapshot.categories.map((category) => category.id)).toEqual(["social", "info", "faq", "game", "fun"]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_settings").first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_categories").first()).resolves.toEqual({ count: 0 });
  });

  it("gates initialization inserts with the management SQL authorization", async () => {
    const deniedRepository = createTextBlockRepository(
      database as unknown as D1Database,
      () => ({ sql: "AND 0", values: [] }),
    );

    await deniedRepository.initialize(CHANNEL_ID, ACTOR, new Date(NOW).toISOString());

    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_settings").first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_library_categories").first()).resolves.toEqual({ count: 0 });
  });

  it("resolves live and offline variants in command and event templates", async () => {
    await expect(createBlock("greeting", [
      variant("live", "Hello live", { stream: "online" }),
      variant("offline", "Hello offline", { stream: "offline" }),
      variant("default", "Hello", {}),
    ])).resolves.toMatchObject({ ok: true });

    const createRenderer = async (templateContext: "chat_command" | "event", isLive: boolean, event: ModuleEvent) =>
      createTemplateRenderer(event, templateContext, [], await sourcesFor({
        streamState: () => Promise.resolve(isLive ? "online" : "offline"),
      }));
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
        renderTemplate: await createRenderer("chat_command", isLive, commandEvent),
      });
      return result.actions.find((action) => action.kind === "chat")?.text;
    };
    await expect(runCommand(true)).resolves.toBe("Hello live");
    await expect(runCommand(false)).resolves.toBe("Hello offline");

    const event: ModuleEvent = { ...commandEvent, subscriptionType: "channel.raid", payload: {}, actor: null, chatStatus: null };
    await expect((await createRenderer("event", true, event))("{greeting}", {})).resolves.toMatchObject({ text: "Hello live" });
    await expect((await createRenderer("event", false, event))("{greeting}", {})).resolves.toMatchObject({ text: "Hello offline" });
  });

  it.each(["1hello", "_hello"]) ("discovers and renders block names beginning with %s", async (name) => {
    await expect(createBlock(name, [variant("default", `Rendered ${name}`)])).resolves.toMatchObject({ ok: true });
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-bare-name-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };
    await expect(renderWithBlocks(`{${name}}`, event, "event")).resolves.toMatchObject({ text: `Rendered ${name}` });
  });

  it("fully resolves host variables (dotted, parameterized) that follow or sit inside a block", async () => {
    await expect(createBlock("welcome", [variant("default", "Hello")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("roll", [variant("default", "You rolled {random 2-5}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("stats", [variant("default", "Points: {var.points}")])).resolves.toMatchObject({ ok: true });

    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-raid-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };
    const createRenderer = async () => createTemplateRenderer(event, "event", [], await sourcesFor({
      readChannelVariables: () => Promise.resolve({ points: 42 }),
      random: () => 0,
    }));

    // A dotted channel variable right after a block, in the same command text (#252).
    await expect((await createRenderer())("{welcome} {var.points}", {})).resolves.toMatchObject({ text: "Hello 42" });
    // A parameterized system variable nested inside a block's own text.
    await expect((await createRenderer())("{roll}", {})).resolves.toMatchObject({ text: "You rolled 2" });
    // A dotted channel variable nested inside a block's own text.
    await expect((await createRenderer())("{stats}", {})).resolves.toMatchObject({ text: "Points: 42" });
  });

  it("does not treat viewer arguments as text block references", async () => {
    await expect(createBlock("welcome", [variant("default", "Expanded block")])).resolves.toMatchObject({ ok: true });
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-command-trigger",
      payload: { message: { text: "!echo {welcome}" }, chatter_user_login: "esembe" },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: null },
      chatStatus: ["viewer"],
    };
    const rendered = await createTemplateRenderer(event, "chat_command", [], await sourcesFor())(
      "{args}",
      { args: "{welcome}" },
    );

    expect(rendered.text).toBe("{welcome}");
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

  it("includes ad and raid templates in generic block usage tracking", async () => {
    await expect(createBlock("answer", [variant("default", "A reusable answer")])).resolves.toMatchObject({ ok: true });
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, ?)")
      .bind(CHANNEL_ID, "ads", JSON.stringify({ ...adsModule.defaultSettings, automatic: "{answer}" })).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, ?)")
      .bind(CHANNEL_ID, "raid", JSON.stringify({ ...raidModule.defaultSettings, textLong: "{answer}" })).run();

    const sources = [
      ...(await adsModule.templateUsageSources?.(database as unknown as D1Database, CHANNEL_ID) ?? []),
      ...(await raidModule.templateUsageSources?.(database as unknown as D1Database, CHANNEL_ID) ?? []),
    ];
    const snapshot = await service.list(CHANNEL_ID, sources);

    expect(snapshot.usages.answer).toEqual([
      { kind: "event", label: "ads.automatic" },
      { kind: "event", label: "raid.textLong" },
    ]);
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
      channelGameId: () => Promise.resolve("77"),
      renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
    });
    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.game_filter");
  });

  it("matches a command game filter when the stream lookup is unavailable", async () => {
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
      channelInfo: () => Promise.resolve(null),
      channelGameId: () => Promise.resolve("42"),
      renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
    });

    expect(result.actions).toContainEqual({ kind: "chat", text: "Guide text" });
  });

  it("keeps role and time conditions tied to command context and channel time", () => {
    const moderatorCondition = { minimumTier: "moderator" as const };
    const state = {
      streamState: "online" as const,
      game: { id: "42", name: "Example Game" },
      chatStatus: ["vip"] as const,
      commandContext: true,
      timeZone: DEFAULT_CHANNEL_TIME_ZONE,
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
    const sourcesForLanguage = async (language: "de" | "en"): Promise<TemplateResolverSources> =>
      sourcesFor({ channelLanguage: () => Promise.resolve(language) });
    const inputVariable = {
      name: "convert",
      contexts: ["chat_command"],
      unavailableContextText: "command_input_error",
      sample: "12",
      maxLength: 12,
    } as const;
    const renderer = createTemplateRenderer(event, "event", [inputVariable], await sourcesForLanguage("en"));
    const germanRenderer = createTemplateRenderer(event, "event", [inputVariable], await sourcesForLanguage("de"));

    await expect(renderer("{args}", {})).resolves.toMatchObject({ text: "Only available in chat commands" });
    await expect(renderer("{convert}", {})).resolves.toMatchObject({ text: "This input is only available in chat commands" });
    await expect(germanRenderer("{args}", {})).resolves.toMatchObject({ text: "Nur in Chatbefehlen verfügbar" });
    await expect(germanRenderer("{convert}", {})).resolves.toMatchObject({ text: "Diese Eingabe ist nur in Chatbefehlen verfügbar" });
  });

  it("bounds nested block expansion and leaves the final chat limit to the send path", async () => {
    await expect(createBlock("random_line", [{ id: "default", conditions: {}, texts: ["first", "second"] }]))
      .resolves.toMatchObject({ ok: true });
    const randomEvent: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-random-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };
    const renderRandom = async (): Promise<string> =>
      (await renderWithBlocks("{random_line}", randomEvent, "event")).text;
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
    const longResult = await renderWithBlocks("{long_line}", event, "event");
    expect(longResult.text).toHaveLength(500);
    expect(longResult.text.endsWith("…")).toBe(true);

    await expect(createBlock("full_line", [variant("default", "z".repeat(500))])).resolves.toMatchObject({ ok: true });
    const message = await renderWithBlocks("{full_line} tail", event, "event");
    expect(message.text).toHaveLength(505);
    expect(message.text.endsWith(" tail")).toBe(true);
    expect(truncateChatText(message.text)).toMatchObject({ truncated: true, text: `${"z".repeat(499)}…` });
  });

  it("does not write single-text choices or consume choices during preview and overlay renders", async () => {
    await expect(createBlock("single_line", [variant("default", "One text")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("multi_line", [{ id: "default", conditions: {}, texts: ["First", "Second"] }]))
      .resolves.toMatchObject({ ok: true });
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-choice-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    };

    await renderWithBlocks("{single_line}", event, "event");
    await renderWithBlocks("{multi_line}", event, "event", {}, "preview");
    await renderWithBlocks("{multi_line}", event, "event", {}, "overlay");

    const rows = await database.prepare(
      "SELECT block_name, last_chosen_index FROM text_block_variants WHERE channel_id = ? ORDER BY block_name",
    ).bind(CHANNEL_ID).all<{ block_name: string; last_chosen_index: number }>();
    expect(rows.results).toEqual([
      { block_name: "multi_line", last_chosen_index: -1 },
      { block_name: "single_line", last_chosen_index: -1 },
    ]);
  });

  it("preserves suffix text when host variables shrink nested expansion below the output limit", async () => {
    await expect(createBlock("args_leaf", [variant("default", "{args}".repeat(83))])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("args_root", [variant("default", "{args_leaf}TAIL")])).resolves.toMatchObject({ ok: true });

    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-command-trigger",
      payload: { message: { text: "!guide" }, chatter_user_login: "esembe" },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: null },
      chatStatus: ["viewer"],
    };
    const rendered = await createTemplateRenderer(event, "chat_command", [], await sourcesFor({
      streamState: () => Promise.resolve("offline"),
    }))("{args_root}", { args: "" });

    expect(rendered.text).toBe("TAIL");
  });

  it("keeps random-choice history separate for each matching variant", async () => {
    await expect(createBlock("status_line", [
      { id: "online", conditions: { stream: "online" }, texts: ["A", "B"] },
      { id: "offline", conditions: { stream: "offline" }, texts: ["B", "A"] },
      variant("default", "fallback"),
    ])).resolves.toMatchObject({ ok: true });
    await database.prepare("UPDATE text_blocks SET last_chosen_index = 1 WHERE channel_id = ? AND block_name = ?")
      .bind(CHANNEL_ID, "status_line").run();
    await database.prepare("UPDATE text_block_variants SET last_chosen_index = 1 WHERE channel_id = ? AND block_name = ? AND variant_id IN ('online', 'offline')")
      .bind(CHANNEL_ID, "status_line").run();

    const render = async (stream: "online" | "offline"): Promise<string> => {
      return (await renderWithBlocks("{status_line}", {
        channelId: CHANNEL_ID,
        subscriptionType: "channel.raid",
        triggerId: "fictional-status-trigger",
        payload: {},
        settings: {},
        receivedAt: new Date(NOW).toISOString(),
        actor: null,
        chatStatus: null,
      }, "event", { streamState: () => Promise.resolve(stream) })).text;
    };

    await expect(render("online")).resolves.toBe("A");
    await expect(render("offline")).resolves.toBe("B");
  });

  it("bounds expansion while resolving exponentially repeated nested references", async () => {
    const repeated = (name: string): string => Array.from({ length: 166 }, () => `{${name}}`).join("");
    await expect(createBlock("a", [variant("default", repeated("b"))])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("b", [variant("default", repeated("c"))])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("c", [variant("default", "x".repeat(500))])).resolves.toMatchObject({ ok: true });

    const result = await renderWithBlocks("{a}", {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.raid",
      triggerId: "fictional-depth-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: null,
      chatStatus: null,
    }, "event");

    expect(result.text).toHaveLength(500);
    expect(result.text.endsWith("…")).toBe(true);
  });

  it("saves an edited panel block through the PATCH route using revision", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the panel test block.");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, CHANNEL_ID, "manager-1", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-1" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-1", TEST_SESSION_KEYS, new Date(NOW).toISOString());
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;
    let patchStatus: number | null = null;
    let patchBody: unknown = null;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const inputUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(inputUrl, "https://brobot.example");
      if (url.pathname === "/api/csrf") {
        return new Response(JSON.stringify({ token: csrf }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const headers = new Headers(init?.headers);
      headers.set("Cookie", `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`);
      const request = input instanceof Request
        ? new Request(input, { ...init, headers })
        : new Request(url, { ...init, headers });
      if (request.method === "PATCH") patchBody = await request.clone().json();
      const response = await panelRouter.fetch(request, environment);
      if (request.method === "PATCH") patchStatus = response.status;
      return response;
    }));

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /\{welcome\}/u }));
    fireEvent.click(within(screen.getByRole("region", { name: "Name" })).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchStatus).toBe(200));
    expect(patchBody).toMatchObject({ name: "welcome", revision: created.block.revision });
    expect(patchBody).not.toHaveProperty("expectedRevision");

    const reserved = await fetch(`/api/channels/${CHANNEL_ID}/modules/text_library/blocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        name: "user",
        categoryId: "social",
        games: [],
        variants: [{ id: "default", conditions: {}, texts: ["Reserved"] }],
      }),
    });
    expect(reserved.status).toBe(400);
    await expect(reserved.json()).resolves.toEqual({ error: "text_library_block_reserved_name" });
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

    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-performance-trigger",
      payload: {},
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: "broadcaster" },
      chatStatus: ["broadcaster"],
    };
    const durations: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now();
      await renderWithBlocks("{top}", event, "chat_command", {
        channelGameId: () => Promise.resolve(currentGame.id),
        streamState: () => Promise.resolve("offline"),
      });
      durations.push(performance.now() - start);
    }
    const averageMs = durations.reduce((total, duration) => total + duration, 0) / durations.length;
    const maximumMs = Math.max(...durations);
    console.info(`Text library worst-case local render: ${averageMs.toFixed(3)} ms average, ${maximumMs.toFixed(3)} ms maximum`);
    expect(maximumMs).toBeLessThan(10);
  });

  it("shows operators the library as read-only with a reason", async () => {
    stubTextLibraryPanelApi({
      blocks: [{
        channelId: CHANNEL_ID,
        name: "welcome",
        categoryId: "social",
        games: [],
        variants: [{ id: "default", conditions: {}, texts: ["Hello"] }],
        revision: 1,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }],
      settings: { revision: 1, graphRevision: 1, updatedAt: new Date(NOW).toISOString() },
      usages: { welcome: [] },
      reservedNames: ["user"],
    });

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage={false} /></MantineProvider>);
    expect(await screen.findByRole("heading", { name: "Text blocks" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("All categories");
    const welcomeRow = screen.getByRole("button", { name: /\{welcome\}/u });
    const welcomeTableRow = welcomeRow.closest("tr");
    expect(welcomeTableRow).toHaveTextContent("1 variant");
    expect(welcomeTableRow).toHaveTextContent("0 uses");
    fireEvent.click(screen.getByRole("button", { name: /\{welcome\}/u }));
    expect(screen.getAllByRole("note")[0]).toHaveTextContent("Only broadcasters and managers can change text blocks and categories.");
    expect(document.querySelector(".text-library__read-only-properties")).toHaveTextContent("Hello");
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Categories"));
    expect(screen.getAllByRole("note")).toHaveLength(2);
    expect(document.querySelectorAll(".text-library__read-only-properties")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Add text block" })).not.toBeInTheDocument();
  });

  it("guards close, Escape, backdrop, and row changes when a text draft is dirty", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const timestamp = new Date(NOW).toISOString();
    let blocks = ["welcome", "faq"].map((name, index) => ({
      channelId: CHANNEL_ID,
      name,
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: [index === 0 ? "Hello" : "FAQ"] }],
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const patchBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/library")) return Promise.resolve(jsonResponse({
        blocks,
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
        settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
        usages: { welcome: [], faq: [] },
        reservedNames: ["user"],
      }));
      if (url.pathname.endsWith("/blocks/welcome") && init?.method === "PATCH") {
        if (typeof init.body !== "string") throw new Error("Text block PATCH body is missing.");
        const body = JSON.parse(init.body) as { variants: Array<{ id: string; conditions: Record<string, unknown>; texts: string[] }> };
        patchBodies.push(body);
        blocks = blocks.map((block) => block.name === "welcome" ? { ...block, variants: body.variants, revision: block.revision + 1 } : block);
        return Promise.resolve(jsonResponse({ block: blocks[0] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /\{welcome\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "Updated" } });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    let guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Continue editing" }));
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Updated");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Text" }), { key: "Escape" });
    guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Continue editing" }));

    const backdrop = document.querySelector(".list-detail__backdrop");
    if (!(backdrop instanceof HTMLElement)) throw new Error("Text library backdrop is missing.");
    fireEvent.click(backdrop);
    guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Continue editing" }));

    fireEvent.click(screen.getByRole("button", { name: /\{faq\}/u }));
    guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save and switch" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ name: "welcome", variants: [{ texts: ["Updated"] }] });
    expect(await screen.findByRole("heading", { name: "Name: faq" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".list-detail__inspector")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /\{faq\}/u }));
  });

  it("registers its dirty-draft guard with the dashboard router so router-driven navigation is blocked", async () => {
    const timestamp = new Date(NOW).toISOString();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/library")) return Promise.resolve(jsonResponse({
        blocks: [{
          channelId: CHANNEL_ID,
          name: "welcome",
          categoryId: "social",
          games: [],
          variants: [{ id: "default", conditions: {}, texts: ["Hello"] }],
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
        settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
        usages: { welcome: [] },
        reservedNames: ["user"],
      }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /\{welcome\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "Updated" } });

    // Simulates the router running its registered guards for sidebar navigation
    // or a browser Back press, entirely outside the panel's own Close/Escape/backdrop handlers.
    const proceed = vi.fn();
    const cancel = vi.fn();
    runDashboardNavigationGuards(proceed, cancel);
    const guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(proceed).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Updated");

    fireEvent.click(within(guard).getByRole("button", { name: "Discard and switch" }));
    expect(proceed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Hello"));
  });

  it("does not offer or save a reserved host variable name as a text block", async () => {
    stubTextLibraryPanelApi({
      blocks: [{
        channelId: CHANNEL_ID,
        name: "user",
        categoryId: "social",
        games: [],
        variants: [{ id: "default", conditions: {}, texts: ["Reserved"] }],
        revision: 1,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }],
      settings: { revision: 1, graphRevision: 1, updatedAt: new Date(NOW).toISOString() },
      usages: {},
      reservedNames: ["user", "system"],
    });

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add text block" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "system" } });

    expect(screen.getByText("This name is reserved for a template variable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /\{user\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "{us" } });
    expect(screen.queryByText("Text block {user}")).not.toBeInTheDocument();
  });

  it("maps the everyone preview tier to the viewer chat status", async () => {
    stubTextLibraryPanelApi({
      blocks: [{
        channelId: CHANNEL_ID,
        name: "everyone_line",
        categoryId: "social",
        games: [],
        variants: [
          { id: "everyone", conditions: { minimumTier: "everyone" }, texts: ["Everyone sees this"] },
          { id: "default", conditions: {}, texts: ["Fallback"] },
        ],
        revision: 1,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }],
      settings: { revision: 1, graphRevision: 1, updatedAt: new Date(NOW).toISOString() },
      usages: { everyone_line: [] },
      reservedNames: ["user"],
    });

    render(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /\{everyone_line\}/u }));
    fireEvent.click(screen.getByRole("combobox", { name: "Preview context" }));
    fireEvent.click(await screen.findByRole("option", { name: "Command" }));

    expect(screen.getByText("Matching variant: Variant 1")).toBeInTheDocument();
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Everyone sees this");
  });
});
