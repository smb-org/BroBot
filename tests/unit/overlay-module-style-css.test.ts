import { readFileSync } from "node:fs";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { generateOverlayStyleBlock } from "../../src/dashboard/overlay-style-model";
import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";

const viewCssByKind: readonly {
  kind: string;
  cssPaths: readonly string[];
  rootClass: string;
  fallbacks: readonly string[];
  usesAccent: boolean;
  legacyConfig?: Readonly<Record<string, unknown>>;
  expectedLegacyDeclarations?: readonly string[];
  legacyColorFallbacks?: readonly string[];
  nullLegacyConfig?: Readonly<Record<string, unknown>>;
}[] = [
  { kind: "ads.countdown", cssPaths: ["../../src/overlay/variable.css"], rootClass: "brobot-module-text", fallbacks: ["transparent", "rgba(255, 255, 255, 0.96)"], usesAccent: false },
  { kind: "belabox.status", cssPaths: ["../../src/overlay/variable.css"], rootClass: "brobot-module-text", fallbacks: ["transparent", "rgba(255, 255, 255, 0.96)"], usesAccent: false },
  { kind: "chat_voting.tally", cssPaths: ["../../src/overlay/variable.css", "../../src/overlay/tally/overlay-tally.css"], rootClass: "brobot-module-text", fallbacks: ["transparent", "rgba(255, 255, 255, 0.96)"], usesAccent: false },
  { kind: "song_requests.now_playing", cssPaths: ["../../src/modules/song_requests/overlay/view.css"], rootClass: "song-requests-now-playing", fallbacks: ["#0d1015", "#f2f5f9", "#c3cbd7", "#a8b2c1", "#1ed760"], usesAccent: true,
    legacyColorFallbacks: [
      "var(--brobot-overlay-background, var(--now-playing-background, var(--brobot-overlay-legacy-background, #0d1015)))",
      "var(--brobot-overlay-text-color, var(--now-playing-text, var(--brobot-overlay-legacy-text-color, #f2f5f9)))",
      "var(--brobot-overlay-secondary-text-color, var(--now-playing-secondary, var(--brobot-overlay-legacy-secondary-text-color, #c3cbd7)))",
      "var(--brobot-overlay-secondary-text-color, var(--now-playing-tertiary, var(--brobot-overlay-legacy-secondary-text-color, #a8b2c1)))",
      "var(--brobot-overlay-accent-color, var(--now-playing-spotify, var(--brobot-overlay-legacy-accent-color, #1ed760)))",
      "var(--brobot-overlay-background, var(--now-playing-surface, #1b212b))",
    ] },
  { kind: "song_requests.queue", cssPaths: ["../../src/modules/song_requests/overlay/queue-view.css"], rootClass: "song-request-queue-overlay", fallbacks: ["#0d1015", "#f2f5f9", "#c3cbd7", "#a8b2c1", "#8ab4ff"], usesAccent: true },
  { kind: "statistics.word_counter", cssPaths: ["../../src/modules/statistics/overlay/view.css"], rootClass: "statistics-word-counter", fallbacks: ["#0d1015", "#f2f5f9", "#a8b2c1"], usesAccent: false,
    legacyColorFallbacks: [
      "var(--brobot-overlay-background, var(--word-counter-background, var(--brobot-overlay-legacy-background, #0d1015)))",
      "var(--brobot-overlay-text-color, var(--word-counter-text, var(--brobot-overlay-legacy-text-color, #f2f5f9)))",
      "var(--brobot-overlay-secondary-text-color, var(--word-counter-secondary, var(--brobot-overlay-legacy-secondary-text-color, #a8b2c1)))",
    ] },
  { kind: "statistics.word_ranking", cssPaths: ["../../src/modules/statistics/overlay/ranking-view.css"], rootClass: "statistics-word-ranking", fallbacks: ["#0d1015", "#f2f5f9", "#a8b2c1", "#35557f"], usesAccent: true,
    legacyColorFallbacks: [
      "var(--brobot-overlay-background, var(--word-counter-background, var(--brobot-overlay-legacy-background, #0d1015)))",
      "var(--brobot-overlay-text-color, var(--word-counter-text, var(--brobot-overlay-legacy-text-color, #f2f5f9)))",
      "var(--brobot-overlay-secondary-text-color, var(--word-counter-secondary, var(--brobot-overlay-legacy-secondary-text-color, #a8b2c1)))",
      "var(--brobot-overlay-accent-color, var(--word-ranking-bar-color, var(--brobot-overlay-legacy-accent-color, #35557f)))",
    ] },
  { kind: "text_library.block", cssPaths: ["../../src/overlay/variable.css"], rootClass: "brobot-module-text", fallbacks: ["transparent", "rgba(255, 255, 255, 0.96)", "rgba(255, 255, 255, 0.78)"], usesAccent: false },
  { kind: "votekick.tally", cssPaths: ["../../src/overlay/variable.css", "../../src/overlay/tally/overlay-tally.css"], rootClass: "brobot-module-text", fallbacks: ["transparent", "rgba(255, 255, 255, 0.96)"], usesAccent: false },
  {
    kind: "quiz.session", cssPaths: ["../../src/modules/quiz/overlay/view.css"], rootClass: "quiz-session-overlay", fallbacks: ["#10141b", "#f2f5f9", "#a8b2c1", "#5fa4ff"], usesAccent: true,
    legacyColorFallbacks: [
      "var(--brobot-overlay-background, var(--quiz-background, var(--brobot-overlay-legacy-background, #10141b)))",
      "var(--brobot-overlay-text-color, var(--quiz-text, var(--brobot-overlay-legacy-text-color, #f2f5f9)))",
      "var(--brobot-overlay-secondary-text-color, var(--quiz-secondary, var(--brobot-overlay-legacy-secondary-text-color, #a8b2c1)))",
      "var(--brobot-overlay-accent-color, var(--quiz-accent, var(--brobot-overlay-legacy-accent-color, #5fa4ff)))",
    ],
    legacyConfig: { showQuestionProgress: false, showPercent: false, backgroundColor: "#112233", textColor: "#223344", secondaryColor: "#334455", accentColor: "#445566", correctColor: "#556677" },
    expectedLegacyDeclarations: ["--brobot-overlay-legacy-background: #112233", "--brobot-overlay-legacy-text-color: #223344", "--brobot-overlay-legacy-secondary-text-color: #334455", "--brobot-overlay-legacy-accent-color: #445566", "--quiz-correct: #556677"],
    nullLegacyConfig: { showQuestionProgress: false, showPercent: false, backgroundColor: null, textColor: null, secondaryColor: null, accentColor: null, correctColor: "#32ca88" },
  },
  {
    kind: "emote_slots.slot", cssPaths: ["../../src/modules/emote_slots/overlay/slot.css"], rootClass: "emote-slot-overlay", fallbacks: ["#090C10", "#F2F5F9", "#C9D1DB", "#2ED3A3"], usesAccent: true,
    legacyColorFallbacks: [
      "var(--brobot-overlay-background, var(--content-game-reel-background, var(--brobot-overlay-legacy-background, #090C10)))",
      "var(--brobot-overlay-text-color, var(--content-game-reel-text, var(--brobot-overlay-legacy-text-color, #F2F5F9)))",
      "var(--brobot-overlay-secondary-text-color, var(--content-game-reel-secondary, var(--brobot-overlay-legacy-secondary-text-color, #C9D1DB)))",
      "var(--brobot-overlay-accent-color, var(--content-game-reel-highlight, var(--brobot-overlay-legacy-accent-color, #2ED3A3)))",
      "var(--content-game-reel-border)",
    ],
    legacyConfig: { backgroundColor: "#112233", textColor: "#223344", secondaryColor: "#334455", highlightColor: "#445566", borderColor: "#556677" },
    expectedLegacyDeclarations: ["--brobot-overlay-legacy-background: #112233", "--brobot-overlay-legacy-text-color: #223344", "--brobot-overlay-legacy-secondary-text-color: #334455", "--brobot-overlay-legacy-accent-color: #445566", "--content-game-reel-border: #556677"],
    nullLegacyConfig: { backgroundColor: null, textColor: null, secondaryColor: null, highlightColor: null, borderColor: null },
  },
  {
    kind: "overlay_alerts.alert", cssPaths: ["../../src/modules/overlay_alerts/overlay/view.css"], rootClass: "overlay-alert", fallbacks: ["rgb(16 20 27 / 84%)", "#ffffff"], usesAccent: false,
    legacyColorFallbacks: ["var(--brobot-overlay-text-color, var(--overlay-alert-text-color, var(--brobot-overlay-legacy-text-color, #ffffff)))"],
    legacyConfig: { textColor: "#abcdef", fontSize: 56 },
    expectedLegacyDeclarations: ["--brobot-overlay-legacy-text-color: #abcdef", "--overlay-alert-font-size: 56px"],
    nullLegacyConfig: { textColor: null, fontSize: 56 },
  },
];

const cssText = (relativePath: string): string => readFileSync(new URL(relativePath, import.meta.url), "utf8");
const customPropertyUsedBy = (cssRule: string, property: string): string | null =>
  new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*var\\((--[a-z0-9-]+)`, "u").exec(cssRule)?.[1] ?? null;

describe("module view integration with shared overlay styles", () => {
  it.each(viewCssByKind)("$kind renders with inherited shared properties and retains its old literal fallbacks", async ({ kind, cssPaths, rootClass, fallbacks, usesAccent, legacyConfig, expectedLegacyDeclarations, legacyColorFallbacks, nullLegacyConfig }) => {
    const registered = MODULE_OVERLAY_ELEMENTS.find(({ definition }) => definition.kind === kind);
    if (registered === undefined) throw new Error(`Element ${kind} is not registered.`);
    const { definition } = registered;
    const view = await definition.load();
    const config = definition.parseConfig(definition.defaultConfig) ?? definition.defaultConfig;
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const state = definition.previewState?.(config, "en", now) ?? {};
    const css = cssPaths.map(cssText).join("\n").replace(/@layer components\.overlay\s*\{/gu, "").replace(/\n\}\s*$/u, "");
    const elementId = "style-element";
    const block = generateOverlayStyleBlock({
      overlay: {},
      elements: {
        [elementId]: {
          color: "#123456",
          secondaryTextColor: "#234567",
          accentColor: "#345678",
          textAlign: "center",
          letterSpacing: 2,
          background: { color: "#456789", opacityPercent: 62 },
        },
      },
    });
    const rootRuleMatch = new RegExp(`\\.${rootClass}[^\\{]*\\{[^{}]*\\}`, "u").exec(css);
    const rootRule = rootRuleMatch?.[0] ?? "";
    const style = document.createElement("style");
    style.textContent = `${rootRule}\n${block}`;
    document.head.appendChild(style);
    const rendered = render(createElement("div", { className: "brobot-overlay" },
      createElement("div", { "data-element": elementId }, createElement(view.default, {
        elementId,
        config,
        state,
        now,
        language: "en",
      }))));
    const moduleRoot = rendered.container.querySelector(`.${rootClass}`);
    expect(moduleRoot).not.toBeNull();
    if (moduleRoot === null) throw new Error(`Element ${kind} did not render its expected view root.`);

    expect(rootRule).toContain("var(--brobot-overlay-text-color");
    expect(rootRule).toMatch(/background(?:-color)?:\s*var\(--brobot-overlay-background/u);
    expect(rootRule).toContain("letter-spacing: var(--brobot-overlay-letter-spacing");
    if (rootClass === "brobot-module-text") expect(block).toContain("text-align: center;");
    else expect(rootRule).toContain("text-align: var(--brobot-overlay-text-align");
    const textColorProperty = customPropertyUsedBy(rootRule, "color");
    const backgroundProperty = customPropertyUsedBy(rootRule, "background(?:-color)?");
    expect(textColorProperty).toBe("--brobot-overlay-text-color");
    expect(backgroundProperty).toBe("--brobot-overlay-background");
    expect(getComputedStyle(moduleRoot).getPropertyValue(textColorProperty ?? "").trim()).toBe("#123456");
    expect(getComputedStyle(moduleRoot).getPropertyValue(backgroundProperty ?? "").trim()).toBe("rgba(69,103,137,0.62)");
    for (const fallback of fallbacks) expect(css).toContain(fallback);
    for (const fallback of legacyColorFallbacks ?? []) expect(css).toContain(fallback);
    expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-text-color").trim()).toBe("#123456");
    expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-secondary-text-color").trim()).toBe("#234567");
    expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-letter-spacing").trim()).toBe("2px");
    expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-text-align").trim()).toBe("center");
    expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-background").trim()).toBe("rgba(69,103,137,0.62)");
    if (usesAccent) {
      expect(css).toContain("var(--brobot-overlay-accent-color");
      expect(getComputedStyle(moduleRoot).getPropertyValue("--brobot-overlay-accent-color").trim()).toBe("#345678");
    }

    if (legacyConfig !== undefined) {
      const legacyRendered = render(createElement("div", { className: "brobot-overlay" },
        createElement("div", { "data-element": "legacy-element" }, createElement(view.default, {
          elementId: "legacy-element",
          config: definition.parseConfig(legacyConfig) ?? legacyConfig,
          state: definition.previewState?.(definition.defaultConfig, "en", now) ?? {},
          now,
          language: "en",
        }))));
      const legacyRoot = legacyRendered.container.querySelector(`.${rootClass}`);
      expect(legacyRoot).not.toBeNull();
      const inlineStyle = legacyRoot?.getAttribute("style") ?? "";
      for (const declaration of expectedLegacyDeclarations ?? []) expect(inlineStyle).toContain(declaration);
      legacyRendered.unmount();
    }

    if (nullLegacyConfig !== undefined) {
      const parsedNullConfig = definition.parseConfig(nullLegacyConfig);
      expect(parsedNullConfig).not.toBeNull();
      const nullRendered = render(createElement("div", { className: "brobot-overlay" },
        createElement("div", { "data-element": "null-element" }, createElement(view.default, {
          elementId: "null-element",
          config: parsedNullConfig ?? nullLegacyConfig,
          state: definition.previewState?.(definition.defaultConfig, "en", now) ?? {},
          now,
          language: "en",
        }))));
      const nullRoot = nullRendered.container.querySelector(`.${rootClass}`);
      expect(nullRoot).not.toBeNull();
      expect(nullRoot?.getAttribute("style") ?? "").not.toContain("--brobot-overlay-legacy-");
      if (kind === "emote_slots.slot") expect(nullRoot?.getAttribute("style") ?? "").toContain("--content-game-reel-border: #353E4B");
      nullRendered.unmount();
    }

    rendered.unmount();
    style.remove();
  });

  // Saved custom CSS may set the colour properties each view read before the Style tab existed.
  const oldColorProperties: readonly (readonly [string, readonly string[]])[] = [
    ["../../src/modules/emote_slots/overlay/slot.css", ["content-game-reel-background", "content-game-reel-border", "content-game-reel-highlight", "content-game-reel-secondary", "content-game-reel-text"]],
    ["../../src/modules/overlay_alerts/overlay/view.css", ["overlay-alert-font-size", "overlay-alert-text-color"]],
    ["../../src/modules/quiz/overlay/view.css", ["quiz-accent", "quiz-background", "quiz-correct", "quiz-secondary", "quiz-text"]],
    ["../../src/modules/song_requests/overlay/view.css", ["now-playing-background", "now-playing-secondary", "now-playing-spotify", "now-playing-surface", "now-playing-tertiary", "now-playing-text"]],
    ["../../src/modules/statistics/overlay/view.css", ["word-counter-background", "word-counter-secondary", "word-counter-text"]],
    ["../../src/modules/statistics/overlay/ranking-view.css", ["word-counter-background", "word-counter-secondary", "word-counter-text", "word-ranking-bar-color", "word-ranking-bar-width", "word-ranking-count"]],
  ];

  it.each(oldColorProperties)("%s keeps consuming every pre-Style custom property", (path, properties) => {
    const css = cssText(path);
    for (const property of properties) expect(css, property).toContain(`var(--${property}`);
  });

  it("statistics views resolve the shared Style value, then the old module property, then the literal", () => {
    for (const path of ["../../src/modules/statistics/overlay/view.css", "../../src/modules/statistics/overlay/ranking-view.css"]) {
      const css = cssText(path);
      expect(css).toMatch(/color: var\(--brobot-overlay-text-color, var\(--word-counter-text, /u);
      expect(css).toMatch(/background: var\(--brobot-overlay-background, var\(--word-counter-background, /u);
    }
  });
});
