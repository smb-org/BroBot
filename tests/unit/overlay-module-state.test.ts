import { describe, expect, it, vi } from "vitest";

import type { BotModule } from "../../src/modules/contract";
import { hydrateModuleOverlayElements } from "../../src/worker/overlays/module-state";

const moduleWithInitialState = (initialState: NonNullable<NonNullable<BotModule["overlayElements"]>[number]["initialState"]>): BotModule => ({
  id: "ads",
  settingsSchema: { parse: (value: unknown) => value } as never,
  defaultSettings: {},
  overlayElements: [{
    kind: "ads.countdown",
    configVersion: 1,
    defaultSize: { width: 300, height: 80 },
    parseConfig: () => ({}),
    initialState,
    load: () => Promise.resolve({ default: () => null }),
  }],
});

const databaseWithEnabledModules = (rows: readonly { module_id: string; enabled: number }[]) => {
  const all = vi.fn(() => Promise.resolve({ results: rows }));
  const statement = {
    bind: vi.fn(() => ({ all })),
  };
  const prepare = vi.fn((sql: string) => {
    void sql;
    return statement;
  });
  return { database: { prepare } as unknown as D1Database, prepare };
};

describe("module overlay bootstrap state", () => {
  it("loads initial state only for enabled modules", async () => {
    const initialState = vi.fn(() => Promise.resolve({ nextAdAt: "2026-09-25T12:00:00.000Z", duration: 90 }));
    const module = moduleWithInitialState(initialState);
    const elements = [{ id: "element-a", kind: "ads.countdown", config: {} }];
    const enabledDatabase = databaseWithEnabledModules([{ module_id: "ads", enabled: 1 }]);
    const disabledDatabase = databaseWithEnabledModules([{ module_id: "ads", enabled: 0 }]);

    const enabled = await hydrateModuleOverlayElements(enabledDatabase.database, "kanal-a", elements, [module]);
    const disabled = await hydrateModuleOverlayElements(disabledDatabase.database, "kanal-a", elements, [module]);

    expect(enabled[0]).toMatchObject({ moduleEnabled: true, state: { nextAdAt: "2026-09-25T12:00:00.000Z", duration: 90 } });
    expect(disabled[0]).toMatchObject({ moduleEnabled: false, state: null });
    expect(initialState.mock.calls).toHaveLength(1);
  });

  it("does not query D1 for overlays without module elements", async () => {
    const database = databaseWithEnabledModules([]);

    await expect(hydrateModuleOverlayElements(database.database, "kanal-a", [{ id: "variable-a", kind: "variable", config: {} }], []))
      .resolves.toEqual([{ id: "variable-a", kind: "variable", config: {} }]);

    expect(database.prepare.mock.calls).toHaveLength(0);
  });
});
