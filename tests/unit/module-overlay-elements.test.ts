import { describe, expect, it } from "vitest";

import type { BotModule, JsonObject, ModuleOverlayElementDefinition } from "../../src/modules/contract";
import { adsModule } from "../../src/modules/ads";
import { validateModuleOverlayElements } from "../../src/modules/registry";

const moduleWithElements = (id: string, kinds: readonly string[]): BotModule => ({
  id,
  settingsSchema: { parse: (value: unknown) => value } as never,
  defaultSettings: {},
  overlayElements: kinds.map((kind): ModuleOverlayElementDefinition => ({
    kind: kind as `${string}.${string}`,
    configVersion: 1,
    defaultSize: { width: 200, height: 80 },
    defaultConfig: {},
    parseConfig: (raw) => typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? raw as JsonObject
      : null,
    load: () => Promise.resolve({ default: () => null }),
  })),
});

describe("module overlay element declarations", () => {
  it("rejects kinds that are not prefixed with their module id", () => {
    expect(() => { validateModuleOverlayElements([moduleWithElements("ads", ["clips.countdown"])]); })
      .toThrow(/prefixed/u);
  });

  it("rejects duplicate kinds across module declarations", () => {
    expect(() => { validateModuleOverlayElements([
      moduleWithElements("ads", ["ads.countdown"]),
      moduleWithElements("ads", ["ads.countdown"]),
    ]); }).toThrow(/unique/u);
  });

  it("declares a lazy countdown element with a neutral default config", () => {
    const countdown = adsModule.overlayElements?.find(({ kind }) => kind === "ads.countdown");

    expect(countdown).toMatchObject({
      kind: "ads.countdown",
      configVersion: 2,
      defaultSize: { width: 300, height: 96 },
      defaultConfig: { showSnoozeInfo: false },
    });
    expect(typeof countdown?.parseConfig).toBe("function");
    expect(typeof countdown?.load).toBe("function");
    expect(typeof countdown?.initialState).toBe("function");
    expect(countdown?.parseConfig({})).toEqual({ showSnoozeInfo: false });
    expect(countdown?.parseConfig({ showSnoozeInfo: true })).toEqual({ showSnoozeInfo: true });
    expect(countdown?.parseConfig({ showSnoozeInfo: "yes" })).toBeNull();
    expect(countdown?.parseConfig({ html: "<b>unsafe</b>" })).toBeNull();
  });
});
