import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleOverlayElementContext } from "../../src/modules/contract";
import { textBlockOverlayState } from "../../src/modules/text_library/overlay/state";
import TextBlockOverlayElement from "../../src/modules/text_library/overlay/view";

const channelId = "fictional-channel";
const sunset = "2026-06-21T20:00:00.000Z";

const contextFor = (overrides: Partial<ModuleOverlayElementContext> = {}): ModuleOverlayElementContext => ({
  now: Date.parse("2026-06-21T19:59:58.000Z"),
  language: "en",
  channelTimeZone: () => Promise.resolve("UTC"),
  streamState: () => Promise.resolve("offline"),
  channelGameId: () => Promise.resolve("game-current"),
  renderTemplate: (text) => Promise.resolve({ text, diagnostics: [] }),
  resolveTemplateConditions: () => Promise.resolve({ "sun.phase": "day" }),
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

  it("hides a deleted block and blocks with unavailable data output", async () => {
    const missingDatabase = {
      prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null) }) }),
    } as unknown as D1Database;
    await expect(textBlockOverlayState(missingDatabase, channelId, { blockName: "sun" }, contextFor())).resolves.toBeNull();

    const db = overlayDatabase([variant("default", "{sun.set_in}", {})]);
    const context = contextFor({
      dynamicTemplateVariableNames: new Set(["sun.set_in"]),
      overlayTemplateVariableNames: new Set(["sun.set_in"]),
      resolveOverlayTemplateValues: () => Promise.resolve({ "sun.set_in": { available: false } }),
    });
    await expect(textBlockOverlayState(db, channelId, { blockName: "sun" }, context)).resolves.toBeNull();
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
});
