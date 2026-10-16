import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent } from "../../src/modules/contract";
import { textLibraryModule } from "../../src/modules/text_library";
import { adsModule } from "../../src/modules/ads";
import { raidModule } from "../../src/modules/raid";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { createFaqRepository } from "../../src/modules/faq/adapters/d1";
import { createTextCommandRepository } from "../../src/modules/text_commands/adapters/d1";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import type { TextBlockConditions, TextBlockVariant, TwitchGame } from "../../src/modules/text_library/contracts";
import { createTextBlockRepository } from "../../src/modules/text_library/adapters/d1";
import { createTextLibraryService } from "../../src/modules/text_library/service";
import { panelRouter } from "../../src/worker/panel/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { firstMatchingTextBlockVariant, textBlockConditionsMatch } from "../../src/modules/text_library/domain";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import TextLibraryPanel from "../../src/modules/text_library/panel/index";
import { textLibraryTexts } from "../../src/modules/text_library/panel/locale";
import { templateTextLength } from "../../src/contracts/template-text-length";
import { createTemplateRenderer, type TemplateResolverSources, type TemplateValueProvider } from "../../src/worker/template-resolver";
import { truncateChatText } from "../../src/worker/chat";
import { DEFAULT_CHANNEL_TIME_ZONE } from "../../src/modules/contract";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";
import { insertChannel, insertLoginIdentityAndSession, insertMember, jsonResponse, testKey } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

const CHANNEL_ID = "esembe";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ACTOR = { userId: "fictional-manager", sessionId: "fictional-session" };
const authorize = () => ({ sql: "AND 1 = 1", values: [] as const });
const TEST_SESSION_KEYS = JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] });
const TEST_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] });

const renderTextLibraryPanel = (canManage = true): void => {
  renderWithQuery(<MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage={canManage} /></MantineProvider>);
};

const variant = (id: string, text: string, conditions: TextBlockConditions = {}): TextBlockVariant => ({
  id,
  conditions,
  texts: [text],
});

const stubTextLibraryPanelApi = (library: unknown, failFirstLibraryRead = false): void => {
  let shouldFailLibraryRead = failFirstLibraryRead;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (shouldFailLibraryRead && url.pathname.includes("/modules/text_library/")) {
      shouldFailLibraryRead = false;
      return Promise.resolve(jsonResponse({ error: "offline" }, 503));
    }
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

  it("declares its category navigation entry without an always-active switch", () => {
    expect(textLibraryModule.navigationEntries?.[0]).toMatchObject({
      id: "texts",
      showMainSwitch: false,
      iconKind: "texts",
      label: { de: "Texte", en: "Texts" },
    });
    expect(textLibraryModule.navigationCategory).toBe("chat");
    expect(textLibraryTexts("de").allCategories).toBe("Alle Kategorien");
    expect(textLibraryTexts("en").allCategories).toBe("All categories");
    expect(textLibraryTexts("de").variantsCount(1)).toBe("1 Variante");
    expect(textLibraryTexts("en").variantsCount(1)).toBe("1 variant");
    expect(textLibraryTexts("de").usesCount(1)).toBe("1 Verwendung");
    expect(textLibraryTexts("en").usesCount(2)).toBe("2 uses");
  });

  it("uses the block text as its template variable catalogue example", async () => {
    const snapshot = await service.list(CHANNEL_ID);
    const created = await service.create({
      channelId: CHANNEL_ID,
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to the stream", "Thanks for joining"] }],
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, ACTOR, snapshot);
    expect(created.ok).toBe(true);

    const variables = await textLibraryModule.templateVariables?.(database as unknown as D1Database, CHANNEL_ID);

    expect(variables).toContainEqual({ name: "text.welcome", sample: "Welcome to the stream", maxLength: 500 });
  });

  it("shows selected weekday conditions as a visible toggle state", async () => {
    const timestamp = new Date(NOW).toISOString();
    stubTextLibraryPanelApi({
      blocks: [{
        channelId: CHANNEL_ID,
        name: "schedule",
        categoryId: "social",
        games: [],
        variants: [
          { id: "weekdays", conditions: { stream: "online", weekdays: [0, 2] }, texts: ["Hello"] },
          { id: "default", conditions: {}, texts: ["Fallback"] },
        ],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: { schedule: [] },
      reservedNames: ["user"],
    });

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.schedule\}/u }));

    const weekdays = screen.getByRole("group", { name: "Weekdays" });
    const sunday = within(weekdays).getByRole("button", { name: "Sunday" });
    const monday = within(weekdays).getByRole("button", { name: "Monday" });
    expect(sunday).toHaveAttribute("aria-pressed", "true");
    expect(sunday).toHaveAttribute("data-variant", "primary");
    expect(monday).toHaveAttribute("aria-pressed", "false");
    expect(monday).toHaveAttribute("data-variant", "neutral");
    expect(screen.queryByRole("button", { name: "Time window in channel time zone" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add time window" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "From" })).not.toBeInTheDocument();

    fireEvent.click(sunday);
    expect(sunday).toHaveAttribute("aria-pressed", "false");
    expect(sunday).toHaveAttribute("data-variant", "neutral");

    fireEvent.click(screen.getByRole("button", { name: "Add time window" }));
    expect(screen.getByRole("textbox", { name: "From" })).toHaveValue("00:00");
  });

  it("shows cached library data immediately when the panel is reopened", async () => {
    const timestamp = new Date(NOW).toISOString();
    stubTextLibraryPanelApi({
      blocks: [{
        channelId: CHANNEL_ID,
        name: "cached_text",
        categoryId: "social",
        games: [],
        variants: [variant("default", "Cached value")],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: { cached_text: [] },
      reservedNames: ["user"],
    });
    function TogglePanel() {
      const [open, setOpen] = useState(true);
      return <MantineProvider>
        <button onClick={() => setOpen((current) => !current)}>Toggle panel</button>
        {open ? <TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /> : null}
      </MantineProvider>;
    }

    renderWithQuery(<TogglePanel />, undefined, { gcTime: 600_000 });
    expect(await screen.findByRole("button", { name: /\{text\.cached_text\}/u })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));

    expect(screen.getByRole("button", { name: /\{text\.cached_text\}/u })).toBeInTheDocument();
  });

  it("accepts a committed block from a recreated resource generation", async () => {
    const timestamp = new Date(NOW).toISOString();
    let block = {
      channelId: CHANNEL_ID,
      name: "welcome",
      categoryId: "social",
      games: [] as TwitchGame[],
      variants: [variant("default", "Old generation")],
      revision: 4,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) return Promise.resolve(jsonResponse({ text: "", diagnostics: [] }));
      if (url.pathname.endsWith("/blocks/welcome") && init?.method === "PATCH") {
        block = {
          ...block,
          variants: [variant("default", "New generation")],
          revision: 1,
          updatedAt: new Date(NOW + 1_000).toISOString(),
        };
        return Promise.resolve(jsonResponse({ block }));
      }
      if (url.pathname.endsWith("/library")) return Promise.resolve(jsonResponse({
        blocks: [block],
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
        settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
        usages: { welcome: [] },
        reservedNames: ["user"],
      }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(
      <MantineProvider><TextLibraryPanel channelId={CHANNEL_ID} language="en" canManage /></MantineProvider>,
      undefined,
      { gcTime: 600_000 },
    );
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.welcome\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "Client draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("New generation"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /\{text\.welcome\}/u }));

    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("New generation");
  });

  it("retries a failed library read", async () => {
    const timestamp = new Date(NOW).toISOString();
    stubTextLibraryPanelApi({
      blocks: [],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: {},
      reservedNames: ["user"],
    }, true);

    renderTextLibraryPanel();

    expect(await screen.findByText("The text library could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry|erneut versuchen/iu }));

    expect(await screen.findByText("No text blocks found.")).toBeInTheDocument();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it("protects a block referenced directly by an otherwise unused parent", async () => {
    const child = await createBlock("child", [variant("default", "Child text")]);
    if (!child.ok) throw new Error("Could not create the child block.");
    const parent = await createBlock("parent", [variant("default", "Nested: {text.child}")]);
    if (!parent.ok) throw new Error("Could not create the parent block.");
    const snapshot = await service.list(CHANNEL_ID);

    const result = await service.delete(CHANNEL_ID, "child", child.block.revision, snapshot.settings.graphRevision, ACTOR, new Date(NOW).toISOString());

    expect(result).toMatchObject({ ok: false, reason: "in_use" });
    await expect(service.find(CHANNEL_ID, "child")).resolves.not.toBeNull();
  });

  it("rechecks consumer references atomically with block deletion", async () => {
    const created = await createBlock("timed_text", [variant("default", "Timer text")]);
    if (!created.ok) throw new Error("Could not create the timer block.");
    const snapshot = await service.list(CHANNEL_ID);
    await database.prepare(
      `INSERT INTO timers (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision, created_at, updated_at)
       VALUES ('timer-race', ?, 'Racing timer', 1, '{text.timed_text}', 'interval', '{"type":"interval","live":{"minutes":10}}', 1, ?, ?)`,
    ).bind(CHANNEL_ID, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();

    const result = await service.delete(CHANNEL_ID, "timed_text", created.block.revision, snapshot.settings.graphRevision, ACTOR, new Date(NOW).toISOString());

    expect(result).toMatchObject({ ok: false, reason: "in_use" });
    await expect(service.find(CHANNEL_ID, "timed_text")).resolves.not.toBeNull();
  });

  it("rechecks FAQ references atomically with block deletion", async () => {
    const created = await createBlock("faq_text", [variant("default", "FAQ text")]);
    if (!created.ok) throw new Error("Could not create the FAQ block.");
    const snapshot = await service.list(CHANNEL_ID);
    await database.prepare(
      `INSERT INTO faq_entries (faq_id, channel_id, name, matcher_type, matcher_json, answer_text, created_at, updated_at)
       VALUES ('faq-race', ?, 'Racing FAQ', 'keywords', '{"patterns":["hello"]}', '{text.faq_text}', ?, ?)`,
    ).bind(CHANNEL_ID, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();

    const result = await service.delete(CHANNEL_ID, "faq_text", created.block.revision, snapshot.settings.graphRevision, ACTOR, new Date(NOW).toISOString());

    expect(result).toMatchObject({ ok: false, reason: "in_use" });
    await expect(service.find(CHANNEL_ID, "faq_text")).resolves.not.toBeNull();
  });

  it("persists box art for a text block and its game condition", async () => {
    const game: TwitchGame = {
      id: "123",
      name: "Example Game",
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/123-{width}x{height}.jpg",
    };
    const snapshot = await service.list(CHANNEL_ID);
    const created = await service.create({
      channelId: CHANNEL_ID,
      name: "game_text",
      categoryId: "social",
      games: [game],
      variants: [variant("game", "In this game", { game: { mode: "is", game } }), variant("default", "Other game")],
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, ACTOR, snapshot);

    expect(created).toMatchObject({ ok: true, block: { games: [game] } });
    const persisted = await repository.find(CHANNEL_ID, "game_text");
    expect(persisted?.games).toEqual([game]);
    expect(persisted?.variants[0]?.conditions.game).toEqual({ mode: "is", game });
  });

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
    channelLocation: () => Promise.resolve(null),
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
    await commands.create({ channelId: CHANNEL_ID, name: "guide", text: "{text.greeting}", kind: "text", cooldownSeconds: 0, now: new Date(NOW).toISOString() }, ACTOR);
    const runCommand = async (isLive: boolean): Promise<string | undefined> => {
      const result = await processTextCommandMessage(commandEvent, commands, {
        renderTemplate: await createRenderer("chat_command", isLive, commandEvent),
      });
      return result.actions.find((action) => action.kind === "chat")?.text;
    };
    await expect(runCommand(true)).resolves.toBe("Hello live");
    await expect(runCommand(false)).resolves.toBe("Hello offline");

    const event: ModuleEvent = { ...commandEvent, subscriptionType: "channel.raid", payload: {}, actor: null, chatStatus: null };
    await expect((await createRenderer("event", true, event))("{text.greeting}", {})).resolves.toMatchObject({ text: "Hello live" });
    await expect((await createRenderer("event", false, event))("{text.greeting}", {})).resolves.toMatchObject({ text: "Hello offline" });
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
    await expect(renderWithBlocks(`{text.${name}}`, event, "event")).resolves.toMatchObject({ text: `Rendered ${name}` });
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
    await expect((await createRenderer())("{text.welcome} {var.points}", {})).resolves.toMatchObject({ text: "Hello 42" });
    // A parameterized system variable nested inside a block's own text.
    await expect((await createRenderer())("{text.roll}", {})).resolves.toMatchObject({ text: "You rolled 2" });
    // A dotted channel variable nested inside a block's own text.
    await expect((await createRenderer())("{text.stats}", {})).resolves.toMatchObject({ text: "Points: 42" });
  });

  it("does not treat viewer arguments as text block references", async () => {
    await expect(createBlock("welcome", [variant("default", "Expanded block")])).resolves.toMatchObject({ ok: true });
    const event: ModuleEvent = {
      channelId: CHANNEL_ID,
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-command-trigger",
      payload: { message: { text: "!echo {text.welcome}" }, chatter_user_login: "esembe" },
      settings: {},
      receivedAt: new Date(NOW).toISOString(),
      actor: { userId: "fictional-user", login: "esembe", role: null },
      chatStatus: ["viewer"],
    };
    const rendered = await createTemplateRenderer(event, "chat_command", [], await sourcesFor())(
      "{args}",
      { args: "{text.welcome}" },
    );

    expect(rendered.text).toBe("{text.welcome}");
  });

  it("rejects cycles and nesting deeper than three blocks when saving", async () => {
    await expect(createBlock("cycle_a", [variant("default", "{text.cycle_b}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("cycle_b", [variant("default", "{text.cycle_a}")])).resolves.toMatchObject({
      ok: false,
      reason: "reference_cycle",
      path: ["cycle_a", "cycle_b", "cycle_a"],
    });

    await expect(createBlock("root", [variant("default", "{text.middle}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("middle", [variant("default", "{text.leaf}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("leaf", [variant("default", "done")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("too_deep", [variant("default", "{text.root}")])).resolves.toMatchObject({
      ok: false,
      reason: "reference_depth_exceeded",
    });
  });

  it("rejects a rename that creates a cycle after references are rewritten", async () => {
    const welcome = await createBlock("welcome", [variant("default", "Welcome")]);
    if (!welcome.ok) throw new Error("Could not create the rename cycle test block.");
    await expect(createBlock("parent", [variant("default", "Nested {text.welcome}")]))
      .resolves.toMatchObject({ ok: true });
    const snapshot = await service.list(CHANNEL_ID);

    const result = await service.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: welcome.block.categoryId,
      games: [],
      variants: [variant("default", "Nested {text.parent}")],
      expectedRevision: welcome.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, "welcome", ACTOR, snapshot);

    expect(result).toMatchObject({ ok: false, reason: "reference_cycle" });
    await expect(service.find(CHANNEL_ID, "welcome")).resolves.toMatchObject({ name: "welcome" });
    await expect(service.find(CHANNEL_ID, "greeting")).resolves.toBeNull();
  });

  it("reports direct and nested uses supplied by generic module contracts", async () => {
    await expect(createBlock("answer", [variant("default", "{text.detail}")])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("detail", [variant("default", "A reusable detail")])).resolves.toMatchObject({ ok: true });
    const snapshot = await service.list(CHANNEL_ID, [{ text: "!faq {text.answer}", kind: "command", label: "!faq" }]);
    expect(snapshot.usages.answer).toEqual([{ kind: "command", label: "!faq" }]);
    expect(snapshot.usages.detail).toEqual([
      { kind: "block", label: "answer" },
      { kind: "command", label: "!faq" },
    ]);
  });

  it("includes ad and raid templates in generic block usage tracking", async () => {
    await expect(createBlock("answer", [variant("default", "A reusable answer")])).resolves.toMatchObject({ ok: true });
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, ?)")
      .bind(CHANNEL_ID, "ads", JSON.stringify({ ...adsModule.defaultSettings, automatic: "{text.answer}" })).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, ?)")
      .bind(CHANNEL_ID, "raid", JSON.stringify({ ...raidModule.defaultSettings, textLong: "{text.answer}" })).run();

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

  it("tracks and rewrites saved, running, retrying, and replayable vote result text", async () => {
    const created = await createBlock("answer", [variant("default", "A reusable answer")]);
    if (!created.ok) throw new Error("Could not create the saved vote result test block.");
    const now = new Date(NOW).toISOString();
    await database.prepare(
      `INSERT INTO chat_vote_templates
        (id, channel_id, shortcut, title, labels, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
       VALUES ('template-dinner', ?, NULL, 'Dinner vote', '["Pizza","Burger"]', NULL, 120, 1, NULL, NULL, ?, ?, 'Result: {text.answer}')`,
    ).bind(CHANNEL_ID, now, now).run();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, close_reason, title, result_text)
       VALUES (?, 'poll-open', 'yes_no', 2, '["Yes","No"]', 'open', ?, ?, 'timer', 'Running vote', 'Running: {text.answer}')`,
    ).bind(CHANNEL_ID, now, new Date(NOW + 120_000).toISOString()).run();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count, title, result_text, result_delivery_pending)
       VALUES (?, 'poll-closed', 'yes_no', 2, '["Yes","No"]', 'closed', ?, ?, ?, 'timer', '[1,0]', 1,
         'Closed vote', 'Closed: {text.answer}', 1)`,
    ).bind(CHANNEL_ID, new Date(NOW - 60_000).toISOString(), now, now).run();
    const sources = await chatVotingModule.templateUsageSources?.(database as unknown as D1Database, CHANNEL_ID) ?? [];
    const snapshot = await service.list(CHANNEL_ID, sources);
    expect(snapshot.usages.answer).toEqual([
      { kind: "event", label: "chat_voting.Dinner vote" },
      { kind: "event", label: "chat_voting.Running vote" },
      { kind: "event", label: "chat_voting.Closed vote" },
    ]);

    const result = await repository.rename({
      channelId: CHANNEL_ID,
      name: "response",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("default", "A reusable answer")],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now,
    }, "answer", ACTOR);

    expect(result).toMatchObject({ ok: true, block: { name: "response" } });
    expect(await database.prepare("SELECT result_text, revision FROM chat_vote_templates WHERE id = 'template-dinner'").first())
      .toEqual({ result_text: "Result: {text.response}", revision: 2 });
    expect(await database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'poll-open'").first())
      .toEqual({ result_text: "Running: {text.response}" });
    expect(await database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'poll-closed'").first())
      .toEqual({ result_text: "Closed: {text.response}" });

    if (!result.ok) throw new Error("Could not rename the referenced text block.");
    await database.prepare(
      "UPDATE chat_votes SET status = 'closed', closed_at = ?, counts_json = '[0,0]', voter_count = 0 WHERE poll_id = 'poll-open'",
    ).bind(now).run();
    const replaySources = await chatVotingModule.templateUsageSources?.(database as unknown as D1Database, CHANNEL_ID) ?? [];
    expect(replaySources).toEqual([
      { text: "Result: {text.response}", kind: "event", label: "chat_voting.Dinner vote" },
      { text: "Closed: {text.response}", kind: "event", label: "chat_voting.Closed vote" },
      { text: "Running: {text.response}", kind: "event", label: "chat_voting.Running vote" },
    ]);
    const replaySnapshot = await service.list(CHANNEL_ID, replaySources);
    const replayRename = await repository.rename({
      channelId: CHANNEL_ID,
      name: "outcome",
      categoryId: result.block.categoryId,
      games: [],
      variants: [variant("default", "A reusable answer")],
      expectedRevision: result.block.revision,
      expectedGraphRevision: replaySnapshot.settings.graphRevision,
      now,
    }, "response", ACTOR);

    expect(replayRename).toMatchObject({ ok: true, block: { name: "outcome" } });
    expect(await database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'poll-open'").first())
      .toEqual({ result_text: "Running: {text.outcome}" });
    expect(await database.prepare("SELECT result_text FROM chat_votes WHERE poll_id = 'poll-closed'").first())
      .toEqual({ result_text: "Closed: {text.outcome}" });
  });

  it("blocks deleting a text block used by a closed vote whose result alarm is retrying", async () => {
    const created = await createBlock("answer", [variant("default", "A reusable answer")]);
    if (!created.ok) throw new Error("Could not create the pending result test block.");
    const now = new Date(NOW).toISOString();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count, title, result_text, result_delivery_pending)
       VALUES (?, 'poll-pending-result', 'yes_no', 2, '["Yes","No"]', 'closed', ?, ?, ?, 'timer', '[1,0]', 1,
         'Pending result', 'Result: {text.answer}', 1)`,
    ).bind(CHANNEL_ID, new Date(NOW - 120_000).toISOString(), new Date(NOW - 60_000).toISOString(), now).run();
    await database.prepare(
      `INSERT INTO chat_votes
        (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, close_reason, title, result_text)
       VALUES (?, 'poll-newer-open', 'yes_no', 2, '["Yes","No"]', 'open', ?, ?, 'timer', 'Newer vote', '{vote.result}')`,
    ).bind(CHANNEL_ID, now, new Date(NOW + 120_000).toISOString()).run();
    const sources = await chatVotingModule.templateUsageSources?.(database as unknown as D1Database, CHANNEL_ID) ?? [];
    const snapshot = await service.list(CHANNEL_ID, sources);
    expect(snapshot.usages.answer).toEqual([{ kind: "event", label: "chat_voting.Pending result" }]);

    const result = await repository.delete(
      CHANNEL_ID,
      "answer",
      created.block.revision,
      snapshot.settings.graphRevision,
      ACTOR,
      now,
    );

    expect(result).toMatchObject({ ok: false, reason: "in_use" });
  });

  it("blocks deleting a text block saved into a vote after the usage scan", async () => {
    const created = await createBlock("answer", [variant("default", "A reusable answer")]);
    if (!created.ok) throw new Error("Could not create the vote reference test block.");
    const snapshot = await service.list(CHANNEL_ID);
    let inserted = false;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        if (!inserted) {
          inserted = true;
          const now = new Date(NOW).toISOString();
          await database.prepare(
            `INSERT INTO chat_vote_templates
              (id, channel_id, shortcut, title, labels, free_text_mode, duration_seconds, revision, legacy_alias, last_used_at, created_at, updated_at, result_text)
             VALUES ('template-race', ?, NULL, 'Concurrent vote', '["Yes","No"]', NULL, 120, 1, NULL, NULL, ?, ?, 'Result: {text.answer}')`,
          ).bind(CHANNEL_ID, now, now).run();
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const interleavedRepository = createTextBlockRepository(interleavedDatabase, authorize);

    const result = await interleavedRepository.delete(
      CHANNEL_ID,
      "answer",
      created.block.revision,
      snapshot.settings.graphRevision,
      ACTOR,
      new Date(NOW).toISOString(),
    );

    expect(result).toMatchObject({ ok: false, reason: "in_use" });
    await expect(service.find(CHANNEL_ID, "answer")).resolves.not.toBeNull();
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

    expect(result.actions).toContainEqual({ kind: "chat", text: "Guide text", automated: false });
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
      (await renderWithBlocks("{text.random_line}", randomEvent, "event")).text;
    const results = await Promise.all(Array.from({ length: 8 }, renderRandom));
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index]).not.toBe(results[index - 1]);
    }

    await expect(createBlock("long_line", [variant("default", "x".repeat(400) + "{text.long_child}")])).resolves.toMatchObject({ ok: true });
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
    const longResult = await renderWithBlocks("{text.long_line}", event, "event");
    expect(longResult.text).toHaveLength(500);
    expect(longResult.text.endsWith("…")).toBe(true);

    await expect(createBlock("full_line", [variant("default", "z".repeat(500))])).resolves.toMatchObject({ ok: true });
    const message = await renderWithBlocks("{text.full_line} tail", event, "event");
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

    await renderWithBlocks("{text.single_line}", event, "event");
    await renderWithBlocks("{text.multi_line}", event, "event", {}, "preview");
    await renderWithBlocks("{text.multi_line}", event, "event", {}, "overlay");

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
    await expect(createBlock("args_root", [variant("default", "{text.args_leaf}TAIL")])).resolves.toMatchObject({ ok: true });

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
    }))("{text.args_root}", { args: "" });

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
      return (await renderWithBlocks("{text.status_line}", {
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
    const repeated = (name: string): string => Array.from({ length: 166 }, () => `{text.${name}}`).join("");
    await expect(createBlock("a", [variant("default", repeated("b"))])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("b", [variant("default", repeated("c"))])).resolves.toMatchObject({ ok: true });
    await expect(createBlock("c", [variant("default", "x".repeat(500))])).resolves.toMatchObject({ ok: true });

    const result = await renderWithBlocks("{text.a}", {
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

  it("saves a text block rename through the PATCH route using revision", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the panel test block.");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, CHANNEL_ID, "manager-1", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-1" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-1", TEST_SESSION_KEYS, new Date().toISOString());
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

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.welcome\}/u }));
    const nameField = screen.getByRole("textbox", { name: "Name" });
    expect(nameField).toBeEnabled();
    fireEvent.change(nameField, { target: { value: "greeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchStatus).toBe(200));
    expect(patchBody).toMatchObject({ name: "greeting", revision: created.block.revision });
    expect(patchBody).not.toHaveProperty("expectedRevision");
    expect(await database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ block_name: "greeting" });

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

  it("renames a block explicitly and rewrites exact references across its consumers", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the rename test block.");
    await createBlock("parent", [variant("default", "Nested {text.welcome}; keep {text.welcomer}")]);
    await insertLoginIdentityAndSession(database, "manager-rename");
    await insertMember(database, CHANNEL_ID, "manager-rename", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-rename" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-rename", TEST_SESSION_KEYS, new Date().toISOString());
    const now = new Date(NOW).toISOString();
    database.sqlite.exec(`
      INSERT INTO text_commands (channel_id, command_name, response_text, template_fields_json, timeout_fallback_text, timeout_reason, created_at, updated_at)
      VALUES ('${CHANNEL_ID}', 'welcome', 'Command {text.welcome}', '{"label":"{text.welcome}"}', 'Try {text.welcome}', 'Reason {text.welcome}', '${now}', '${now}');
      INSERT INTO timers (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
      VALUES ('timer-rename', '${CHANNEL_ID}', 'Reminder', 1, 'interval', '{}', 'Timer {text.welcome}', '${now}', '${now}');
      INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
      VALUES ('faq-rename', '${CHANNEL_ID}', 'Greeting', '{"patterns":["hello"]}', 'FAQ {text.welcome}', '${now}', '${now}');
      INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
      VALUES ('${CHANNEL_ID}', 'ads', 1, '{"automatic":"Ad {text.welcome}"}');
      INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
      VALUES ('overlay-rename', '${CHANNEL_ID}', 'Welcome', '${now}', '${now}');
      INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text, config_json)
      VALUES ('element-rename', '${CHANNEL_ID}', 'overlay-rename', 'text', 'Overlay {text.welcome}', '{"content":"{text.welcome}"}');
      INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, config_json)
      VALUES ('element-block-rename', '${CHANNEL_ID}', 'overlay-rename', 'text_library.block', '{"blockName":"welcome"}');
    `);
    const faqRepository = createFaqRepository(database as unknown as D1Database);
    const cachedFaqMatchers = await faqRepository.matchers(CHANNEL_ID, NOW);
    expect(cachedFaqMatchers[0]?.entry.revision).toBe(1);
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;

    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [{ id: "default", conditions: {}, texts: ["Hello again"] }],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ block: { name: "greeting", revision: created.block.revision + 1 } });
    expect(await database.prepare("SELECT block_name FROM text_block_variants WHERE channel_id = ? AND block_name = ?")
      .bind(CHANNEL_ID, "greeting").all()).toMatchObject({ results: [{ block_name: "greeting" }] });
    expect(await database.prepare("SELECT texts_json FROM text_block_variants WHERE channel_id = ? AND block_name = ?")
      .bind(CHANNEL_ID, "parent").first()).toEqual({ texts_json: '["Nested {text.greeting}; keep {text.welcomer}"]' });
    expect(await database.prepare("SELECT response_text, template_fields_json, timeout_fallback_text, timeout_reason, revision FROM text_commands WHERE channel_id = ? AND command_name = ?")
      .bind(CHANNEL_ID, "welcome").first()).toMatchObject({
      response_text: "Command {text.greeting}",
      template_fields_json: '{"label":"{text.greeting}"}',
      timeout_fallback_text: "Try {text.greeting}",
      timeout_reason: "Reason {text.greeting}",
      revision: 2,
    });
    expect(await database.prepare("SELECT message_text, revision FROM timers WHERE timer_id = ?")
      .bind("timer-rename").first()).toMatchObject({ message_text: "Timer {text.greeting}", revision: 2 });
    expect(await database.prepare("SELECT answer_text, revision FROM faq_entries WHERE faq_id = ?")
      .bind("faq-rename").first()).toMatchObject({ answer_text: "FAQ {text.greeting}", revision: 2 });
    const refreshedFaqMatchers = await faqRepository.matchers(CHANNEL_ID, NOW + 1);
    expect(refreshedFaqMatchers[0]?.entry.revision).toBe(2);
    expect(await database.prepare("SELECT settings, revision FROM channel_modules WHERE channel_id = ? AND module_id = ?")
      .bind(CHANNEL_ID, "ads").first()).toMatchObject({ settings: '{"automatic":"Ad {text.greeting}"}', revision: 2 });
    expect(await database.prepare("SELECT text, config_json FROM overlay_elements WHERE element_id = ?")
      .bind("element-rename").first()).toEqual({ text: "Overlay {text.greeting}", config_json: '{"content":"{text.greeting}"}' });
    expect(await database.prepare("SELECT config_json FROM overlay_elements WHERE element_id = ?")
      .bind("element-block-rename").first()).toEqual({ config_json: '{"blockName":"greeting"}' });
    expect(await database.prepare("SELECT revision FROM overlays WHERE overlay_id = ?")
      .bind("overlay-rename").first()).toEqual({ revision: 2 });
    const audit = await database.prepare("SELECT action, before_json, after_json FROM audit_log WHERE channel_id = ? AND module_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(CHANNEL_ID, "text_library").first<{ action: string; before_json: string; after_json: string }>();
    expect(audit?.action).toBe("text_library.block.renamed");
    expect(audit?.before_json).toContain("welcome");
    expect(audit?.after_json).toContain("greeting");
  });

  it("rewrites only references owned by the channel whose block was renamed", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the channel-scoped rename block.");
    const otherChannelId = "other-channel-rename";
    await insertChannel(database, otherChannelId);
    const otherSnapshot = await service.list(otherChannelId);
    const otherBlock = await service.create({
      channelId: otherChannelId,
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [variant("default", "Other channel hello")],
      expectedGraphRevision: otherSnapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, ACTOR, otherSnapshot);
    if (!otherBlock.ok) throw new Error("Could not create the same-named block in the other channel.");
    const now = new Date(NOW).toISOString();
    await database.prepare(
      `INSERT INTO timers (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'interval', '{}', ?, ?, ?)`,
    ).bind("timer-other-channel-rename", otherChannelId, "Other reminder", "Timer {text.welcome}", now, now).run();
    await insertLoginIdentityAndSession(database, "manager-channel-scoped-rename");
    await insertMember(database, CHANNEL_ID, "manager-channel-scoped-rename", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-channel-scoped-rename" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-channel-scoped-rename", TEST_SESSION_KEYS, new Date().toISOString());
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;

    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [variant("default", "Hello again")],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(database.prepare("SELECT message_text FROM timers WHERE timer_id = ?")
      .bind("timer-other-channel-rename").first()).resolves.toEqual({ message_text: "Timer {text.welcome}" });
    await expect(database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ? AND block_name = ?")
      .bind(otherChannelId, "welcome").first()).resolves.toEqual({ block_name: "welcome" });
    await expect(database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ? AND block_name = ?")
      .bind(CHANNEL_ID, "greeting").first()).resolves.toEqual({ block_name: "greeting" });
  });

  it("keeps a used block and its reference consistent during concurrent rename and delete requests", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the concurrent rename/delete block.");
    const now = new Date(NOW).toISOString();
    await database.prepare(
      `INSERT INTO timers (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'interval', '{}', ?, ?, ?)`,
    ).bind("timer-concurrent-rename-delete", CHANNEL_ID, "Reminder", "Timer {text.welcome}", now, now).run();
    await insertLoginIdentityAndSession(database, "manager-concurrent-rename-delete");
    await insertMember(database, CHANNEL_ID, "manager-concurrent-rename-delete", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-concurrent-rename-delete" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-concurrent-rename-delete", TEST_SESSION_KEYS, new Date().toISOString());
    const headers = {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
    };
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;
    const rename = panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [variant("default", "Hello again")],
          revision: created.block.revision,
        }),
      },
    ), environment);
    const remove = panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome?revision=${String(created.block.revision)}`,
      { method: "DELETE", headers: { "X-CSRF-Token": csrf, Cookie: headers.Cookie } },
    ), environment);
    const [renamed, deleted] = await Promise.all([rename, remove]);

    expect(renamed.status).toBe(200);
    expect([404, 409]).toContain(deleted.status);
    if (deleted.status === 409) await expect(deleted.json()).resolves.toMatchObject({ error: "text_library_block_in_use" });
    await expect(database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ?")
      .bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [{ block_name: "greeting" }] });
    await expect(database.prepare("SELECT message_text FROM timers WHERE timer_id = ?")
      .bind("timer-concurrent-rename-delete").first()).resolves.toEqual({ message_text: "Timer {text.greeting}" });
  });

  it("rejects a rename when a timer is committed after consumer compatibility validation", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the concurrent consumer test block.");
    await insertLoginIdentityAndSession(database, "manager-concurrent-consumer");
    await insertMember(database, CHANNEL_ID, "manager-concurrent-consumer", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-concurrent-consumer" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-concurrent-consumer", TEST_SESSION_KEYS, new Date().toISOString());
    const now = new Date(NOW).toISOString();
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("SELECT timer_id, name, message_text FROM timers WHERE channel_id = ?"),
      async () => {
        await database.prepare(
          `INSERT INTO timers
            (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'interval', '{}', ?, ?, ?)`,
        ).bind("timer-concurrent-consumer", CHANNEL_ID, "Reminder", "Timer {text.welcome}", now, now).run();
      },
    );
    const environment = {
      DB: interleavedDatabase,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;

    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [{ id: "default", conditions: {}, texts: ["{args}"] }],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "text_library_block_conflict" });
    await expect(database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ? ORDER BY block_name")
      .bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [{ block_name: "welcome" }] });
    await expect(database.prepare("SELECT message_text, revision FROM timers WHERE timer_id = ?")
      .bind("timer-concurrent-consumer").first()).resolves.toMatchObject({ message_text: "Timer {text.welcome}", revision: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?")
      .bind(CHANNEL_ID, "text_library.block.renamed").first()).resolves.toEqual({ count: 0 });
  });

  it("keeps text block rename concurrency-safe and rejects a stale revision", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the concurrency test block.");
    await insertLoginIdentityAndSession(database, "manager-stale-rename");
    await insertMember(database, CHANNEL_ID, "manager-stale-rename", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-stale-rename" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-stale-rename", TEST_SESSION_KEYS, new Date().toISOString());
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;
    const rename = (name: string, revision: number) => panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name,
          categoryId: "social",
          games: [],
          variants: [{ id: "default", conditions: {}, texts: ["Hello"] }],
          revision,
        }),
      },
    ), environment);

    const current = await rename("welcome", created.block.revision);
    expect(current.status).toBe(200);
    const stale = await rename("greeting", created.block.revision);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "text_library_block_conflict" });
    const renamed = await rename("greeting", created.block.revision + 1);
    expect(renamed.status).toBe(200);
    const staleAfterRename = await rename("salutation", created.block.revision + 1);
    expect(staleAfterRename.status).toBe(404);
    expect(await database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ? ORDER BY block_name")
      .bind(CHANNEL_ID).all()).toMatchObject({ results: [{ block_name: "greeting" }] });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?")
      .bind(CHANNEL_ID, "text_library.block.renamed").first()).toEqual({ count: 1 });
  });

  it("persists edited, added, and removed variants when a block is renamed", async () => {
    const created = await createBlock("welcome", [
      { id: "weekday", conditions: { stream: "offline" }, texts: ["Welcome"] },
      { id: "weekend", conditions: { weekdays: [0, 6] }, texts: ["Weekend welcome"] },
      { id: "default", conditions: {}, texts: ["Fallback welcome"] },
    ]);
    if (!created.ok) throw new Error("Could not create the rename variant test block.");
    await insertLoginIdentityAndSession(database, "manager-variant-rename");
    await insertMember(database, CHANNEL_ID, "manager-variant-rename", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-variant-rename" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-variant-rename", TEST_SESSION_KEYS, new Date().toISOString());
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;
    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [
            { id: "weekday", conditions: { stream: "online", weekdays: [1] }, texts: ["Edited greeting"] },
            { id: "evening", conditions: { weekdays: [5] }, texts: ["New evening greeting"] },
            { id: "default", conditions: {}, texts: ["Fallback greeting"] },
          ],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      block: {
        name: "greeting",
        variants: [
          { id: "weekday", conditions: { stream: "online", weekdays: [1] }, texts: ["Edited greeting"] },
          { id: "evening", conditions: { weekdays: [5] }, texts: ["New evening greeting"] },
          { id: "default", conditions: {}, texts: ["Fallback greeting"] },
        ],
      },
    });
    await expect(database.prepare(
      "SELECT variant_id, position, conditions_json, texts_json FROM text_block_variants WHERE channel_id = ? AND block_name = ? ORDER BY position",
    ).bind(CHANNEL_ID, "greeting").all()).resolves.toMatchObject({
      results: [
        { variant_id: "weekday", position: 0, conditions_json: '{"stream":"online","weekdays":[1]}', texts_json: '["Edited greeting"]' },
        { variant_id: "evening", position: 1, conditions_json: '{"weekdays":[5]}', texts_json: '["New evening greeting"]' },
        { variant_id: "default", position: 2, conditions_json: "{}", texts_json: '["Fallback greeting"]' },
      ],
    });
  });

  it("leaves every consumer unchanged when different sources race for one rename target", async () => {
    const created = await createBlock("welcome", [variant("default", "Original")]);
    if (!created.ok) throw new Error("Could not create the overlapping rename test block.");
    const other = await createBlock("other", [variant("default", "Other original")]);
    if (!other.ok) throw new Error("Could not create the competing rename source.");
    const parent = await createBlock("parent", [variant("default", "Parent uses {text.other}")]);
    if (!parent.ok) throw new Error("Could not create the rename consumer block.");
    const snapshot = await service.list(CHANNEL_ID);
    const now = new Date(NOW).toISOString();
    database.sqlite.exec(`
      INSERT INTO text_commands (channel_id, command_name, response_text, template_fields_json, timeout_fallback_text, timeout_reason, created_at, updated_at)
      VALUES ('${CHANNEL_ID}', 'other-command', 'Command {text.other}', '{"label":"{text.other}"}', 'Try {text.other}', 'Reason {text.other}', '${now}', '${now}');
      INSERT INTO timers (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
      VALUES ('timer-other-rename', '${CHANNEL_ID}', 'Other reminder', 1, 'interval', '{}', 'Timer {text.other}', '${now}', '${now}');
      INSERT INTO faq_entries (faq_id, channel_id, name, matcher_json, answer_text, created_at, updated_at)
      VALUES ('faq-other-rename', '${CHANNEL_ID}', 'Other answer', '{"patterns":["other"]}', 'FAQ {text.other}', '${now}', '${now}');
      INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
      VALUES ('${CHANNEL_ID}', 'ads', 1, '{"automatic":"Ad {text.other}"}');
      INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
      VALUES ('overlay-other-rename', '${CHANNEL_ID}', 'Other', '${now}', '${now}');
      INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text, config_json)
      VALUES ('element-other-rename', '${CHANNEL_ID}', 'overlay-other-rename', 'text', 'Overlay {text.other}', '{"content":"{text.other}"}');
    `);
    let resolveFirstAtBatch!: () => void;
    let resolveSecondAtBatch!: () => void;
    let resolveFirstBatchFinished!: () => void;
    const firstAtBatch = new Promise<void>((resolve) => { resolveFirstAtBatch = resolve; });
    const secondAtBatch = new Promise<void>((resolve) => { resolveSecondAtBatch = resolve; });
    const firstBatchFinished = new Promise<void>((resolve) => { resolveFirstBatchFinished = resolve; });
    let batchCount = 0;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        batchCount += 1;
        if (batchCount === 1) {
          resolveFirstAtBatch();
          await secondAtBatch;
          const result = await database.batch(statements);
          resolveFirstBatchFinished();
          return result;
        }
        resolveSecondAtBatch();
        await firstBatchFinished;
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const interleavedRepository = createTextBlockRepository(interleavedDatabase, authorize);
    const rename = (fromName: string, expectedRevision: number, text: string) => interleavedRepository.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("default", text)],
      expectedRevision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now,
    }, fromName, ACTOR);

    const winnerPromise = rename("welcome", created.block.revision, "Winning variant");
    await firstAtBatch;
    const loserPromise = rename("other", other.block.revision, "Losing variant");
    const [winner, loser] = await Promise.all([winnerPromise, loserPromise]);

    expect(winner).toMatchObject({ ok: true, block: { name: "greeting" } });
    expect(loser).toMatchObject({ ok: false, reason: "already_exists" });
    await expect(database.prepare(
      "SELECT texts_json FROM text_block_variants WHERE channel_id = ? AND block_name = ? AND variant_id = ?",
    ).bind(CHANNEL_ID, "greeting", "default").first()).resolves.toEqual({ texts_json: '["Winning variant"]' });
    await expect(database.prepare(
      "SELECT revision FROM text_blocks WHERE channel_id = ? AND block_name = ?",
    ).bind(CHANNEL_ID, "greeting").first()).resolves.toEqual({ revision: created.block.revision + 1 });
    await expect(database.prepare(
      "SELECT block_name, revision FROM text_blocks WHERE channel_id = ? AND block_name IN (?, ?) ORDER BY block_name",
    ).bind(CHANNEL_ID, "other", "parent").all()).resolves.toMatchObject({
      results: [
        { block_name: "other", revision: other.block.revision },
        { block_name: "parent", revision: parent.block.revision },
      ],
    });
    await expect(database.prepare(
      "SELECT block_name, texts_json FROM text_block_variants WHERE channel_id = ? AND block_name IN (?, ?) ORDER BY block_name",
    ).bind(CHANNEL_ID, "other", "parent").all()).resolves.toMatchObject({
      results: [
        { block_name: "other", texts_json: '["Other original"]' },
        { block_name: "parent", texts_json: '["Parent uses {text.other}"]' },
      ],
    });
    await expect(database.prepare(
      "SELECT response_text, template_fields_json, timeout_fallback_text, timeout_reason, revision FROM text_commands WHERE channel_id = ? AND command_name = ?",
    ).bind(CHANNEL_ID, "other-command").first()).resolves.toMatchObject({
      response_text: "Command {text.other}",
      template_fields_json: '{"label":"{text.other}"}',
      timeout_fallback_text: "Try {text.other}",
      timeout_reason: "Reason {text.other}",
      revision: 1,
    });
    await expect(database.prepare(
      "SELECT message_text, revision FROM timers WHERE timer_id = ?",
    ).bind("timer-other-rename").first()).resolves.toEqual({ message_text: "Timer {text.other}", revision: 1 });
    await expect(database.prepare(
      "SELECT answer_text, revision FROM faq_entries WHERE faq_id = ?",
    ).bind("faq-other-rename").first()).resolves.toEqual({ answer_text: "FAQ {text.other}", revision: 1 });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = ? AND module_id = ?",
    ).bind(CHANNEL_ID, "ads").first()).resolves.toEqual({ settings: '{"automatic":"Ad {text.other}"}', revision: 1 });
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE overlay_id = ?",
    ).bind("overlay-other-rename").first()).resolves.toEqual({ revision: 1 });
    await expect(database.prepare(
      "SELECT text, config_json FROM overlay_elements WHERE element_id = ?",
    ).bind("element-other-rename").first()).resolves.toEqual({ text: "Overlay {text.other}", config_json: '{"content":"{text.other}"}' });
  });

  it("validates timer compatibility against renamed block content", async () => {
    const created = await createBlock("welcome", [variant("default", "Welcome")]);
    if (!created.ok) throw new Error("Could not create the template compatibility test block.");
    await createBlock("parent", [variant("default", "Nested {text.welcome}")]);
    await database.prepare(`INSERT INTO timers
      (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'interval', '{}', ?, ?, ?)`)
      .bind("timer-rename-compatibility", CHANNEL_ID, "Reminder", "Use {text.parent}", new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
    await insertLoginIdentityAndSession(database, "manager-rename-compatibility");
    await insertMember(database, CHANNEL_ID, "manager-rename-compatibility", "manager");
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-rename-compatibility" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-rename-compatibility", TEST_SESSION_KEYS, new Date().toISOString());
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
    } as unknown as Env;

    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "greeting",
          categoryId: "social",
          games: [],
          variants: [variant("default", "{args}")],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "text_library_template_usage_invalid",
      issues: [{ reason: "input_dependent", consumerName: "Reminder" }],
    });
    await expect(service.find(CHANNEL_ID, "welcome")).resolves.toMatchObject({ name: "welcome" });
    await expect(service.find(CHANNEL_ID, "greeting")).resolves.toBeNull();
  });

  it("rolls back a rename if saving its submitted variants fails", async () => {
    const created = await createBlock("welcome", [variant("default", "Welcome")]);
    if (!created.ok) throw new Error("Could not create the atomic rename test block.");
    const snapshot = await service.list(CHANNEL_ID);
    database.sqlite.exec(`
      CREATE TRIGGER reject_block_variant_insert
      BEFORE INSERT ON text_block_variants
      WHEN NEW.variant_id = 'blocked'
      BEGIN
        SELECT RAISE(ABORT, 'blocked variant');
      END;
    `);

    await expect(repository.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("blocked", "Edited welcome")],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, "welcome", ACTOR)).rejects.toThrow();

    await expect(service.find(CHANNEL_ID, "welcome")).resolves.toMatchObject({
      name: "welcome",
      variants: [variant("default", "Welcome")],
    });
    await expect(service.find(CHANNEL_ID, "greeting")).resolves.toBeNull();
    await expect(database.prepare("SELECT graph_revision FROM text_library_settings WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ graph_revision: snapshot.settings.graphRevision });
  });

  it("rejects a rename that would exceed a consumer template length", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the template length test block.");
    await database.prepare(`INSERT INTO timers (timer_id, channel_id, name, enabled, trigger_type, trigger_json, message_text, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'interval', '{}', ?, ?, ?)`)
      .bind("timer-length", CHANNEL_ID, "Long reminder", `${"x".repeat(491)}{text.welcome}`, new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
    const snapshot = await service.list(CHANNEL_ID);

    const result = await repository.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("default", "Hello")],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, "welcome", ACTOR);

    expect(result).toMatchObject({ ok: false, reason: "template_too_long" });
    expect(await database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ block_name: "welcome" });
    expect(await database.prepare("SELECT message_text FROM timers WHERE timer_id = ?")
      .bind("timer-length").first()).toEqual({ message_text: `${"x".repeat(491)}{text.welcome}` });
  });

  it("allows a renamed overlay token whose semantic length remains within the limit", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the overlay length test block.");
    const originalText = `${"x".repeat(86)}{text.welcome}`;
    const renamedText = originalText.replaceAll("{text.welcome}", "{text.greeting}");
    expect(originalText.length).toBe(100);
    expect(renamedText.length).toBeGreaterThan(100);
    expect(templateTextLength(renamedText)).toBeLessThanOrEqual(100);
    const now = new Date(NOW).toISOString();
    await database.prepare("INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind("overlay-length", CHANNEL_ID, "Length", now, now).run();
    await database.prepare("INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, text, config_json) VALUES (?, ?, ?, 'text', ?, '{}')")
      .bind("element-length", CHANNEL_ID, "overlay-length", originalText).run();
    const snapshot = await service.list(CHANNEL_ID);

    const result = await repository.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("default", "Hello")],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now,
    }, "welcome", ACTOR);

    expect(result).toMatchObject({ ok: true, block: { name: "greeting" } });
    await expect(database.prepare("SELECT text FROM overlay_elements WHERE element_id = ?")
      .bind("element-length").first()).resolves.toEqual({ text: renamedText });
  });

  it("rejects a rename when a consumer changes after validation starts", async () => {
    const created = await createBlock("welcome", [variant("default", "Hello")]);
    if (!created.ok) throw new Error("Could not create the concurrent consumer test block.");
    const snapshot = await service.list(CHANNEL_ID);
    let inserted = false;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        if (!inserted) {
          inserted = true;
          await database.prepare(`INSERT INTO text_commands (channel_id, command_name, response_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`)
            .bind(CHANNEL_ID, "concurrent", "Use {text.welcome}", new Date(NOW).toISOString(), new Date(NOW).toISOString()).run();
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const interleavedRepository = createTextBlockRepository(interleavedDatabase, authorize);

    const result = await interleavedRepository.rename({
      channelId: CHANNEL_ID,
      name: "greeting",
      categoryId: created.block.categoryId,
      games: [],
      variants: [variant("default", "Hello")],
      expectedRevision: created.block.revision,
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date(NOW).toISOString(),
    }, "welcome", ACTOR);

    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(await database.prepare("SELECT block_name FROM text_blocks WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).toEqual({ block_name: "welcome" });
    expect(await database.prepare("SELECT response_text FROM text_commands WHERE channel_id = ? AND command_name = ?")
      .bind(CHANNEL_ID, "concurrent").first()).toEqual({ response_text: "Use {text.welcome}" });
  });

  it("invalidates edited overlay blocks and refuses to delete a block used by an overlay", async () => {
    const created = await createBlock("welcome", [variant("default", "Before edit")]);
    if (!created.ok) throw new Error("Could not create the realtime test block.");
    const parent = await createBlock("parent", [variant("default", "Nested: {text.welcome}")]);
    if (!parent.ok) throw new Error("Could not create the parent realtime test block.");
    await insertLoginIdentityAndSession(database, "manager-overlay-edit");
    await insertMember(database, CHANNEL_ID, "manager-overlay-edit", "manager");
    database.sqlite.exec(`
      INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
      VALUES ('overlay-welcome', '${CHANNEL_ID}', 'Welcome', 1280, 720, '', 1, '${new Date(NOW).toISOString()}', '${new Date(NOW).toISOString()}');
      INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json)
      VALUES ('element-welcome', '${CHANNEL_ID}', 'overlay-welcome', 'text_library.block', '', NULL, '', '{"blockName":"parent"}');
    `);
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-manager-overlay-edit" },
      TEST_SESSION_KEYS,
      TEST_ENCRYPTION_KEYS,
    );
    const csrf = await createCsrfToken("session-manager-overlay-edit", TEST_SESSION_KEYS, new Date().toISOString());
    const published: unknown[] = [];
    const channel = {
      idFromName: (name: string) => name,
      get: () => ({ publish: (messages: readonly unknown[]) => {
        published.push(...messages);
        return Promise.resolve();
      } }),
    };
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      SESSION_COOKIE_KEYS: TEST_SESSION_KEYS,
      SESSION_ENCRYPTION_KEYS: TEST_ENCRYPTION_KEYS,
      CHANNEL: channel,
    } as unknown as Env;
    const response = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
        body: JSON.stringify({
          name: "welcome",
          categoryId: "social",
          games: [],
          variants: [{ id: "default", conditions: {}, texts: ["Updated private block text"] }],
          revision: created.block.revision,
        }),
      },
    ), environment);

    expect(response.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "modul.text_library.blocks_updated",
      payload: { blockName: "parent" },
      overlayIds: ["overlay-welcome"],
    });
    expect(JSON.stringify(published[0])).not.toContain("Updated private block text");

    const updated = await response.json<{ block: { revision: number } }>();
    published.length = 0;
    const deleted = await panelRouter.fetch(new Request(
      `https://brobot.example/api/channels/${CHANNEL_ID}/modules/text_library/blocks/welcome?revision=${String(updated.block.revision)}`,
      {
        method: "DELETE",
        headers: {
          "X-CSRF-Token": csrf,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
        },
      },
    ), environment);

    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toEqual({
      error: "text_library_block_in_use",
      usages: [
        { kind: "block", label: "parent" },
        { kind: "overlay", label: "Welcome" },
      ],
    });
    expect(published).toHaveLength(0);
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
    const render = () => renderWithBlocks("{text.top}", event, "chat_command", {
      channelGameId: () => Promise.resolve(currentGame.id),
      streamState: () => Promise.resolve("offline"),
    });
    // Warm up (JIT, module caches) before timing so the measured runs reflect steady-state cost.
    await render();
    await render();
    const durations: number[] = [];
    for (let index = 0; index < 7; index += 1) {
      const start = performance.now();
      await render();
      durations.push(performance.now() - start);
    }
    // A single wall-clock sample is scheduler noise that only ever adds time, never subtracts it,
    // so the minimum across several iterations is the best estimate of actual CPU cost.
    const minimumMs = Math.min(...durations);
    const maximumMs = Math.max(...durations);
    console.info(`Text library worst-case local render: ${minimumMs.toFixed(3)} ms minimum, ${maximumMs.toFixed(3)} ms maximum`);
    expect(minimumMs).toBeLessThan(10);
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

    renderTextLibraryPanel(false);
    await screen.findByTestId("text-library-list-slot");
    expect(await screen.findByRole("heading", { name: "Text blocks" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveTextContent("All categories");
    const welcomeRow = screen.getByRole("button", { name: /\{(?:text\.)?welcome\}/u });
    expect(welcomeRow).toHaveTextContent("1 variant");
    expect(welcomeRow).toHaveTextContent("0 uses");
    fireEvent.click(screen.getByRole("button", { name: /\{text\.welcome\}/u }));
    expect(screen.getAllByText("Only broadcasters and managers can change text blocks and categories.")).toHaveLength(1);
    expect(document.querySelector(".text-library__read-only-properties")).toHaveTextContent("Hello");
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Categories"));
    expect(screen.getByRole("note")).toHaveTextContent("Only broadcasters and managers may add text blocks.");
    expect(document.querySelectorAll(".text-library__read-only-properties")).toHaveLength(2);
    const addButton = screen.getByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    expect(addButton.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("guards close, Escape, and row changes when a text draft is dirty", async () => {
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

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.welcome\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "Updated" } });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    let guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Continue editing" }));
    expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Updated");

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Text" }), { key: "Escape" });
    guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Continue editing" }));

    fireEvent.click(screen.getByRole("button", { name: /\{text\.faq\}/u }));
    guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save and switch" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toMatchObject({ name: "welcome", variants: [{ texts: ["Updated"] }] });
    expect(await screen.findByRole("heading", { name: "{text.faq}" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "false"));
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

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.welcome\}/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "Updated" } });

    // Simulates the router running its registered guards for sidebar navigation
    // or a browser Back press, entirely outside the panel's own Close/Escape/backdrop handlers.
    const proceed = vi.fn();
    const cancel = vi.fn();
    runDashboardNavigationGuards(proceed, cancel);
    const guard = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(proceed).not.toHaveBeenCalled();
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

    renderTextLibraryPanel();
    await screen.findByTestId("text-library-list-slot");
    fireEvent.click(await screen.findByRole("button", { name: "Add text block" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "system" } });

    expect(screen.getByText("This name is reserved for a template variable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: /\{(?:text\.)?user\}/u }));
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

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.everyone_line\}/u }));
    fireEvent.click(screen.getByRole("combobox", { name: "Preview context" }));
    clickSelectOption(await screen.findByRole("option", { name: "Command" }));

    expect(screen.getByText("Matching variant: Variant 1")).toBeInTheDocument();
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Everyone sees this");
  });

  it("debounces text edits into one server preview request and reuses the CSRF token", async () => {
    const timestamp = new Date(NOW).toISOString();
    const library = {
      blocks: [{
        channelId: CHANNEL_ID,
        name: "preview_line",
        categoryId: "social",
        games: [],
        variants: [variant("default", "First")],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: { preview_line: [] },
      reservedNames: [],
    };
    let resolveFinalPreview: ((response: Response) => void) | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: unknown } : {};
        if (body.text === "Final") return new Promise<Response>((resolve) => { resolveFinalPreview = resolve; });
        return Promise.resolve(jsonResponse({ text: `Rendered ${typeof body.text === "string" ? body.text : ""}`, diagnostics: [] }));
      }
      return Promise.resolve(jsonResponse(library));
    });
    vi.stubGlobal("fetch", fetcher);

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.preview_line\}/u }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname.endsWith("/template-preview"))).toHaveLength(1));
    await waitFor(() => expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered First"));

    fetcher.mockClear();
    vi.useFakeTimers();
    const textField = screen.getByRole("textbox", { name: "Text" });
    fireEvent.change(textField, { target: { value: "Second" } });
    fireEvent.change(textField, { target: { value: "Third" } });
    fireEvent.change(textField, { target: { value: "Final" } });

    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(fetcher.mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname.endsWith("/template-preview"))).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const previewCalls = fetcher.mock.calls.filter(([input]) => new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname.endsWith("/template-preview"));
    expect(previewCalls).toHaveLength(1);
    expect(fetcher.mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname === "/api/csrf")).toBe(false);
    expect(JSON.parse(previewCalls[0]?.[1]?.body as string)).toMatchObject({ text: "Final" });
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered First");
    await act(async () => {
      resolveFinalPreview?.(jsonResponse({ text: "Rendered Final", diagnostics: [] }));
      await Promise.resolve();
    });
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered Final");
  });

  it("ignores a late preview response from a superseded request", async () => {
    const timestamp = new Date(NOW).toISOString();
    const library = {
      blocks: [{
        channelId: CHANNEL_ID,
        name: "preview_line",
        categoryId: "social",
        games: [],
        variants: [variant("default", "First")],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: { preview_line: [] },
      reservedNames: [],
    };
    let resolveSecondPreview: ((response: Response) => void) | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: unknown } : {};
        if (body.text === "Second") return new Promise<Response>((resolve) => { resolveSecondPreview = resolve; });
        return Promise.resolve(jsonResponse({ text: `Rendered ${typeof body.text === "string" ? body.text : ""}`, diagnostics: [] }));
      }
      return Promise.resolve(jsonResponse(library));
    });
    vi.stubGlobal("fetch", fetcher);

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.preview_line\}/u }));
    await waitFor(() => expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered First"));

    vi.useFakeTimers();
    const textField = screen.getByRole("textbox", { name: "Text" });
    fireEvent.change(textField, { target: { value: "Second" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    // "Second" is now in flight and stays pending on purpose.

    fireEvent.change(textField, { target: { value: "Final" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered Final");

    await act(async () => {
      resolveSecondPreview?.(jsonResponse({ text: "Rendered Second", diagnostics: [] }));
      await Promise.resolve();
    });
    // The superseded "Second" response must not clobber the current "Final" preview.
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered Final");
  });

  it("falls back to the raw template when the latest preview request fails, without leaving stale text", async () => {
    const timestamp = new Date(NOW).toISOString();
    const library = {
      blocks: [{
        channelId: CHANNEL_ID,
        name: "preview_line",
        categoryId: "social",
        games: [],
        variants: [variant("default", "First")],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: timestamp, updatedAt: timestamp }],
      settings: { revision: 1, graphRevision: 1, updatedAt: timestamp },
      usages: { preview_line: [] },
      reservedNames: [],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: DEFAULT_CHANNEL_TIME_ZONE, revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { text?: unknown } : {};
        if (body.text === "Broken") return Promise.resolve(jsonResponse({ error: "boom" }, 500));
        return Promise.resolve(jsonResponse({ text: `Rendered ${typeof body.text === "string" ? body.text : ""}`, diagnostics: [] }));
      }
      return Promise.resolve(jsonResponse(library));
    });
    vi.stubGlobal("fetch", fetcher);

    renderTextLibraryPanel();
    fireEvent.click(await screen.findByRole("button", { name: /\{text\.preview_line\}/u }));
    await waitFor(() => expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Rendered First"));

    vi.useFakeTimers();
    const textField = screen.getByRole("textbox", { name: "Text" });
    fireEvent.change(textField, { target: { value: "Broken" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
    });

    // No stale "Rendered First" left over; falls back to the raw (unrendered) template.
    expect(document.querySelector(".ui-chat-preview__text")).toHaveTextContent("Broken");
    expect(document.querySelector(".ui-chat-preview__text")).not.toHaveTextContent("Rendered First");
  });
});
