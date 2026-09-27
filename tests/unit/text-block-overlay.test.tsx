import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ModuleOverlayElementContext } from "../../src/modules/contract";
import { textBlockOverlayState } from "../../src/modules/text_library/overlay/state";
import TextBlockOverlayElement from "../../src/modules/text_library/overlay/view";

const channelId = "fictional-channel";
const sunset = "2026-06-21T20:00:00.000Z";

const contextFor = (overrides: Partial<ModuleOverlayElementContext> = {}): ModuleOverlayElementContext => ({
  now: Date.parse("2026-06-21T19:59:58.000Z"),
  language: "en",
  channelTimeZone: () => Promise.resolve("UTC"),
  streamState: () => Promise.resolve("offline"),
  streamStartedAt: () => null,
  streamDetailsCacheExpiresAt: () => null,
  hasLookupFailure: () => false,
  channelGameId: () => Promise.resolve("game-current"),
  renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
  resolveTemplateConditions: () => Promise.resolve({ values: { "sun.phase": "day" }, attributionsByCondition: {} }),
  resolveTemplateConditionTransitions: () => Promise.resolve([{ at: sunset, values: { "sun.phase": "night" } }]),
  resolveOverlayTemplateValues: () => Promise.resolve({}),
  timeDependentTemplateConditionIds: new Set(["sun.phase"]),
  dynamicTemplateVariableNames: new Set(),
  overlayTemplateVariableNames: new Set(),
  ...overrides,
});

const overlayDatabase = (
  variants: readonly Record<string, unknown>[],
  childBlocks: Readonly<Record<string, readonly Record<string, unknown>[]>> = {},
) => {
  const variantsByBlock: Readonly<Record<string, readonly Record<string, unknown>[]>> = { sun: variants, ...childBlocks };
  const prepare = (sql: string) => ({
    bind: (_channelId: string, name: string) => ({
      first: () => Promise.resolve(sql.includes("FROM text_blocks") ? variantsByBlock[name] === undefined ? null : {
        block_name: name,
        games_json: "[]",
        revision: 1,
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } : null),
      all: () => Promise.resolve({ results: variantsByBlock[name] ?? [] }),
    }),
  });
  return { prepare } as unknown as D1Database;
};

const variant = (variant_id: string, text: string, conditions: Record<string, unknown>, position = 0) => ({
  variant_id,
  position,
  conditions_json: JSON.stringify(conditions),
  texts_json: JSON.stringify([text]),
});

describe("text block overlay rendering", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers only server-eligible variants and keeps the day/night candidates", async () => {
    const db = overlayDatabase([
      variant("online", "ONLINE_PRIVATE", { stream: "online" }, 0),
      variant("other_game", "GAME_PRIVATE", { game: { mode: "is", game: { id: "game-other", name: "Other game" } } }, 1),
      variant("role", "ROLE_PRIVATE", { minimumTier: "moderator" }, 2),
      variant("night", "NIGHT_CANDIDATE", { data: { "sun.phase": "night" } }, 3),
      variant("stable", "STABLE_CANDIDATE", { game: { mode: "is", game: { id: "game-current", name: "Current game" } } }, 4),
      variant("default", "DEFAULT_PRIVATE", {}, 5),
    ]);
    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, contextFor());

    expect(state).not.toBeNull();
    const serialized = JSON.stringify(state);
    expect(serialized).toContain("NIGHT_CANDIDATE");
    expect(serialized).toContain("STABLE_CANDIDATE");
    expect(serialized).not.toContain("DEFAULT_PRIVATE");
    expect(serialized).not.toContain("ONLINE_PRIVATE");
    expect(serialized).not.toContain("GAME_PRIVATE");
    expect(serialized).not.toContain("ROLE_PRIVATE");
    expect(serialized).toContain(sunset);
  });

  it("includes provider attribution for a condition-selected candidate", async () => {
    const db = overlayDatabase([
      variant("rain", "Rain is coming", { data: { "weather.condition": "rain" } }),
    ]);
    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, contextFor({
      resolveTemplateConditions: () => Promise.resolve({
        values: { "weather.condition": "rain" },
        attributionsByCondition: { "weather.condition": ["Open-Meteo"] },
      }),
    }));

    expect(state).toMatchObject({
      candidates: [{ text: "Rain is coming", attributions: ["Open-Meteo"] }],
    });
  });

  it("switches to the night candidate at sunset and ticks a countdown in the browser", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-06-21T19:59:58.000Z");
    vi.setSystemTime(now);
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const state = {
      serverNow: new Date(now).toISOString(),
      timeZone: "UTC",
      dataConditions: { "sun.phase": "day" },
      transitions: [{ at: sunset, values: { "sun.phase": "night" } }],
      switchTimes: [sunset],
      countdownTargets: { "sun.set_in": [sunset, "2026-06-22T20:00:00.000Z"] },
      candidates: [
        { conditions: { data: { "sun.phase": "night" } }, text: "Night" },
        { conditions: {}, text: "Sunset in {sun.set_in}" },
      ],
    };
    const overlayElement = (nextState: typeof state) => <TextBlockOverlayElement
      config={{ blockName: "sun" }}
      state={nextState}
      now={Date.now()}
      language="en"
    />;

    const { rerender } = render(overlayElement(state));
    expect(screen.getByText("Sunset in 1 min")).toBeInTheDocument();
    monotonicNow += 2_000;
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText("Night")).toBeInTheDocument();
    expect(screen.queryByText(/Sunset in/u)).not.toBeInTheDocument();

    const laterState = {
      ...state,
      serverNow: new Date(now).toISOString(),
      dataConditions: { "sun.phase": "day" },
      candidates: [{ conditions: {}, text: "Sunset in {sun.set_in}" }],
    };
    rerender(overlayElement(laterState));
    monotonicNow += 60_000;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("Sunset in 23 hr 59 min")).toBeInTheDocument();
  });

  it("shows zero for an ongoing phase countdown instead of counting down to its end", () => {
    const now = Date.parse("2026-06-21T03:00:00.000Z");
    const state = {
      serverNow: new Date(now).toISOString(),
      timeZone: "Europe/Berlin",
      dataConditions: {},
      transitions: [],
      countdownTargets: { "sun.golden_hour_in": ["2026-06-21T02:40:00.000Z"] },
      candidates: [{ conditions: {}, text: "Golden hour in {sun.golden_hour_in}" }],
    };

    render(<TextBlockOverlayElement config={{ blockName: "sun" }} state={state} now={now} language="en" />);

    expect(screen.getByText("Golden hour in 0 min")).toBeInTheDocument();
  });

  it("hides a deleted block and blocks with unavailable data output", async () => {
    const missingDatabase = {
      prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null) }) }),
    } as unknown as D1Database;
    await expect(textBlockOverlayState(missingDatabase, channelId, { blockName: "sun" }, contextFor())).resolves.toBeNull();

    // A countdown with no target in its lookahead window (e.g. a polar-night sunset)
    // drops every candidate, but the overlay still needs a refreshAt so it re-bootstraps
    // once the target reappears, instead of staying blank forever.
    const db = overlayDatabase([variant("default", "{sun.set_in}", {})]);
    const context = contextFor({
      dynamicTemplateVariableNames: new Set(["sun.set_in"]),
      overlayTemplateVariableNames: new Set(["sun.set_in"]),
      resolveOverlayTemplateValues: () => Promise.resolve({ "sun.set_in": { available: false } }),
    });
    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);
    expect(state).toMatchObject({ candidates: [], countdownTargets: {} });
    const refreshAt = (state as { refreshAt?: string } | null)?.refreshAt;
    expect(typeof refreshAt).toBe("string");
    expect(Date.parse(refreshAt as string)).toBeGreaterThan(context.now);
  });

  it("matches is_not game variants when the channel has no current game", async () => {
    const db = overlayDatabase([
      variant("different_game", "NOT_THIS_GAME", {
        game: { mode: "is_not", game: { id: "game-other", name: "Other game" } },
      }),
      variant("default", "FALLBACK", {}),
    ]);
    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, contextFor({
      channelGameId: () => Promise.resolve(null),
    }));

    expect(state).not.toBeNull();
    expect(JSON.stringify(state)).toContain("NOT_THIS_GAME");
    expect(JSON.stringify(state)).not.toContain("FALLBACK");
  });

  it("collects nested countdown targets and time conditions and schedules a reload before the nested switch", async () => {
    const child = [
      variant("night", "Sunset {sun.set_in}", { data: { "sun.phase": "night" } }, 0),
      variant("default", "Sunrise {sun.rise_in}", {}, 1),
    ];
    const db = overlayDatabase([variant("default", "{child}", {})], { child });
    const resolveValues = vi.fn(() => Promise.resolve({
      "sun.set_in": { available: true, targetAts: [sunset] },
      "sun.rise_in": { available: true, targetAts: ["2026-06-22T04:00:00.000Z"] },
    }));
    const resolveTransitions = vi.fn(() => Promise.resolve([{ at: sunset, values: { "sun.phase": "night" } }]));
    const context = contextFor({
      renderTemplate: (text) => Promise.resolve({ text: text.replace("{child}", "Sunset {sun.set_in}"), diagnostics: [] }),
      resolveOverlayTemplateValues: resolveValues,
      resolveTemplateConditionTransitions: resolveTransitions,
      dynamicTemplateVariableNames: new Set(["sun.set_in", "sun.rise_in"]),
      overlayTemplateVariableNames: new Set(["sun.set_in", "sun.rise_in"]),
    });
    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(resolveValues).toHaveBeenCalledWith(["sun.set_in"]);
    expect(resolveTransitions).toHaveBeenCalledWith(["sun.phase"], context.now, context.now + 7 * 24 * 60 * 60 * 1_000);
    expect(state).toMatchObject({
      countdownTargets: { "sun.set_in": [sunset] },
      transitions: [{ at: sunset, values: { "sun.phase": "night" } }],
      candidates: [{ text: "Sunset {sun.set_in}" }],
      refreshAt: "2026-06-21T19:59:59.000Z",
    });
  });

  it("schedules a text block refresh from a module value's generic next-change hint", async () => {
    const now = Date.parse("2026-06-21T19:59:58.000Z");
    const nextChangeAt = "2026-06-21T20:30:00.000Z";
    const db = overlayDatabase([variant("default", "Moon {moon.phase}", {})]);
    const resolveValues = vi.fn(() => Promise.resolve({ "moon.phase": { available: true, nextChangeAt } }));
    const context = contextFor({
      now,
      renderTemplate: (text) => Promise.resolve({ text: text.replace("{moon.phase}", "Waxing gibbous"), diagnostics: [] }),
      overlayTemplateVariableNames: new Set(["moon.phase"]),
      resolveOverlayTemplateValues: resolveValues,
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(resolveValues).toHaveBeenCalledWith(["moon.phase"]);
    expect(state).toMatchObject({
      candidates: [{ text: "Moon Waxing gibbous" }],
      refreshAt: new Date(Date.parse(nextChangeAt) + 1_000).toISOString(),
    });
  });

  it("schedules a reload from the earliest sunrise or sunset countdown", async () => {
    const sunrise = "2026-06-21T22:00:00.000Z";
    const sunsetLater = "2026-06-22T03:00:00.000Z";
    const db = overlayDatabase([variant("default", "Sunrise {sun.rise_in}, sunset {sun.set_in}", {})]);
    const context = contextFor({
      dynamicTemplateVariableNames: new Set(["sun.rise_in", "sun.set_in"]),
      overlayTemplateVariableNames: new Set(["sun.rise_in", "sun.set_in"]),
      resolveOverlayTemplateValues: () => Promise.resolve({
        "sun.rise_in": { available: true, targetAts: [sunrise] },
        "sun.set_in": { available: true, targetAts: [sunsetLater] },
      }),
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({
      countdownTargets: { "sun.rise_in": [sunrise], "sun.set_in": [sunsetLater] },
      refreshAt: "2026-06-21T22:00:01.000Z",
    });
  });

  it("refreshes a countdown at its target instead of once per second during the final hour", async () => {
    const target = "2026-06-21T20:29:58.000Z";
    const db = overlayDatabase([variant("default", "Sunset in {sun.set_in}", {})]);
    const context = contextFor({
      dynamicTemplateVariableNames: new Set(["sun.set_in"]),
      overlayTemplateVariableNames: new Set(["sun.set_in"]),
      resolveOverlayTemplateValues: () => Promise.resolve({
        "sun.set_in": { available: true, targetAt: target },
      }),
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);
    const refreshAt = Date.parse((state as { refreshAt: string }).refreshAt);

    expect(refreshAt).toBe(Date.parse(target) + 1_000);
    expect(refreshAt - context.now).toBeGreaterThan(29 * 60 * 1_000);
  });

  it("refreshes viewer counts at the cache expiry regardless of the stored stream state", async () => {
    const db = overlayDatabase([variant("default", "Live viewers: {viewers}", {})]);
    const now = contextFor().now;
    const liveContext = contextFor({
      streamState: () => Promise.resolve("online"),
      streamDetailsCacheExpiresAt: () => now + 5_000,
    });
    const offlineContext = contextFor({
      streamState: () => Promise.resolve("offline"),
      streamDetailsCacheExpiresAt: () => now + 5_000,
    });
    const unknownContext = contextFor({
      streamState: () => Promise.resolve("unknown"),
      streamDetailsCacheExpiresAt: () => now + 5_000,
    });

    const liveState = await textBlockOverlayState(db, channelId, { blockName: "sun" }, liveContext);
    const offlineState = await textBlockOverlayState(db, channelId, { blockName: "sun" }, offlineContext);
    const unknownState = await textBlockOverlayState(db, channelId, { blockName: "sun" }, unknownContext);

    for (const state of [liveState, offlineState, unknownState]) {
      expect(state).toMatchObject({ refreshAt: new Date(now + 5_000).toISOString() });
    }
  });

  it("schedules refreshed template values at their displayed time boundaries", async () => {
    const timeDatabase = overlayDatabase([variant("default", "It is {time}, uptime {uptime}", {})]);
    const timeContext = contextFor({
      now: Date.parse("2026-06-21T19:59:58.000Z"),
    });
    const timeState = await textBlockOverlayState(timeDatabase, channelId, { blockName: "sun" }, timeContext);
    expect(timeState).toMatchObject({ refreshAt: "2026-06-21T20:00:00.000Z" });

    const dateDatabase = overlayDatabase([variant("default", "Today is {date}", {})]);
    const dateContext = contextFor({
      now: Date.parse("2026-06-21T19:59:58.000Z"),
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
    });
    const dateState = await textBlockOverlayState(dateDatabase, channelId, { blockName: "sun" }, dateContext);
    expect(dateState).toMatchObject({ refreshAt: "2026-06-21T22:00:00.000Z" });
  });

  it("refreshes uptime at the stream-start minute phase", async () => {
    const now = Date.parse("2026-06-21T19:31:00.000Z");
    const db = overlayDatabase([variant("default", "Uptime {uptime}", {})]);
    const context = contextFor({
      now,
      streamStartedAt: () => "2026-06-21T19:00:20.000Z",
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({ refreshAt: "2026-06-21T19:31:20.000Z" });
  });

  it("retries a failed title or game lookup instead of freezing its output", async () => {
    const db = overlayDatabase([variant("default", "{title}", {})]);
    const context = contextFor({
      renderTemplate: () => Promise.resolve({
        text: "?",
        diagnostics: [{ code: "template.lookup_unavailable", detail: { name: "title" } }],
      }),
      hasLookupFailure: () => true,
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({ refreshAt: new Date(context.now + 30_000).toISOString() });
  });

  it("retries an unavailable game filter without rendering it as a confirmed mismatch", async () => {
    const db = overlayDatabase([variant("game", "Game scoped", {
      game: { mode: "is", game: { id: "game-current", name: "Current game" } },
    })]);
    const context = contextFor({
      channelGameId: () => Promise.resolve(null),
      hasLookupFailure: () => true,
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({
      candidates: [],
      refreshAt: new Date(context.now + 30_000).toISOString(),
    });
  });

  it("schedules a refresh after fixed sun times advance to their next event", async () => {
    const sunrise = "2026-06-21T20:30:00.000Z";
    const sunset = "2026-06-21T21:00:00.000Z";
    const dusk = "2026-06-21T21:30:00.000Z";
    const db = overlayDatabase([variant("default", "Rise {sun.rise}, set {sun.set}, dusk {sun.dusk}", {})]);
    const context = contextFor({
      overlayTemplateVariableNames: new Set(["sun.rise", "sun.set", "sun.dusk"]),
      resolveOverlayTemplateValues: () => Promise.resolve({
        "sun.rise": { available: true, targetAt: sunrise, nextChangeAt: sunrise },
        "sun.set": { available: true, targetAt: sunset, nextChangeAt: sunset },
        "sun.dusk": { available: true, targetAt: dusk, nextChangeAt: dusk },
      }),
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({ refreshAt: "2026-06-21T20:30:01.000Z" });
  });

  it("retries when the fixed-sun lookup fails after an earlier lookup for the same block already succeeded", async () => {
    const db = overlayDatabase([variant("default", "Sunset {sun.set}", {})]);
    let lookupCalls = 0;
    let failed = false;
    const context = contextFor({
      overlayTemplateVariableNames: new Set(["sun.set"]),
      hasLookupFailure: () => failed,
      resolveOverlayTemplateValues: () => {
        lookupCalls += 1;
        if (lookupCalls === 1) return Promise.resolve({ "sun.set": { available: true, targetAt: sunset } });
        failed = true;
        return Promise.resolve({ "sun.set": { available: false } });
      },
    });

    const state = await textBlockOverlayState(db, channelId, { blockName: "sun" }, context);

    expect(state).toMatchObject({ refreshAt: new Date(context.now + 30_000).toISOString() });
  });
});
