import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";

afterEach(cleanup);

const customColorByPart = {
  background: "#123456",
  text: "#234567",
  secondaryText: "#345678",
  accent: "#456789",
} as const;

describe("module overlay appearance", () => {
  it.each(MODULE_OVERLAY_ELEMENTS)("$definition.kind applies custom colors and transparent backgrounds", async ({ definition }) => {
    const appearance = Object.fromEntries(definition.appearance.parts.map((part) => [part, customColorByPart[part]]));
    const config = definition.parseConfig({ ...definition.defaultConfig, appearance });
    expect(config).not.toBeNull();
    if (config === null) return;

    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const loaded = await definition.load();
    const Component = loaded.default;
    const state = definition.previewState?.(config, "en", now) ?? null;
    const view = render(createElement(Component, { config, state, now, language: "en" }));
    const root = view.container.firstElementChild as HTMLElement | null;

    expect(root).not.toBeNull();
    for (const part of definition.appearance.parts) {
      expect(root?.style.getPropertyValue(`--overlay-appearance-${part === "secondaryText" ? "secondary-text" : part}`)).toBe(customColorByPart[part]);
    }

    const transparentConfig = definition.parseConfig({ ...config, appearance: { ...appearance, background: "transparent" } });
    expect(transparentConfig).not.toBeNull();
    if (transparentConfig === null) return;
    const transparentState = definition.previewState?.(transparentConfig, "en", now) ?? null;
    view.rerender(createElement(Component, { config: transparentConfig, state: transparentState, now, language: "en" }));
    expect((view.container.firstElementChild as HTMLElement | null)?.style.getPropertyValue("--overlay-appearance-background")).toBe("transparent");
  });
});
