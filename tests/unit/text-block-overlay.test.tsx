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

const overlayDatabase = (variants: readonly Record<string, unknown>[]) => {
  const prepare = (sql: string) => ({
    bind: () => ({
      first: () => Promise.resolve(sql.includes("FROM text_blocks") ? {
        block_name: "sun",
        games_json: "[]",
        revision: 1,
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } : null),
      all: () => Promise.resolve({ results: variants }),
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
});
