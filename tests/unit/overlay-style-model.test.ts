import { describe, expect, it } from "vitest";

import {
  OVERLAY_STYLE_BEGIN_MARKER,
  OVERLAY_STYLE_END_MARKER,
  generateOverlayStyleBlock,
  generateOverlayStyleContent,
  migrateLegacyOverlayStyles,
  migrateLegacyOverlayStylesToCss,
  overlayElementTextColors,
  parseOverlayStyleBlock,
  replaceOverlayStyleBlock,
  resolveOverlayElementColors,
  type OverlayStyleDocument,
} from "../../src/dashboard/overlay-style-model";
import { overlayAppearanceContrastRatio } from "../../src/dashboard/overlay-contrast";
import { OVERLAY_CSS_MAXIMUM_LENGTH } from "../../src/contracts/overlay-css";

const styles: OverlayStyleDocument = {
  overlay: {
    fontFamily: "Inter",
    fontSize: 32,
    fontWeight: 600,
    color: "#ffffff",
    secondaryTextColor: "#aabbcc",
    accentColor: "#123456",
    textAlign: "center",
    lineHeight: 1.2,
    letterSpacing: -0.00000001,
    stroke: { width: 2, color: "#000000" },
    shadow: { x: -0.00000001, y: 2, blur: 4, color: "#000000" },
    background: { color: "#112233", opacityPercent: 37 },
    padding: 8,
    borderRadius: 6,
  },
  elements: {
    element_b: { fontFamily: "A \"quoted\" font", fontSize: 64, color: "#ffcc00", secondaryTextColor: "#aabbcc", accentColor: "#123456", textAlign: "right" },
    element_a: { fontWeight: 700, color: "#abcdef", secondaryTextColor: "#334455", accentColor: "#667788" },
  },
};

describe("overlay style block model", () => {
  it("moves legacy module colors into element styles and keeps other config options", () => {
    const migrated = migrateLegacyOverlayStyles([
      {
        id: "quiz-one",
        kind: "quiz.session",
        config: {
          backgroundColor: "#112233",
          textColor: null,
          secondaryColor: "#445566",
          accentColor: "#778899",
          correctColor: "#32ca88",
          showPercent: false,
        },
      },
    ], { overlay: {}, elements: {} });

    expect(migrated.styles.elements["quiz-one"]).toEqual({
      background: { color: "#112233", opacityPercent: 100 },
      color: "#f2f5f9",
      secondaryTextColor: "#445566",
      accentColor: "#778899",
    });
    expect(migrated.elements[0]?.config).toEqual({ correctColor: "#32ca88", showPercent: false });
  });

  it("includes the slot jackpot accent color in text contrast checks", () => {
    const elementStyle = {
      background: { color: "#555555", opacityPercent: 100 },
      color: "#ffffff",
      secondaryTextColor: "#eeeeee",
      accentColor: "#777777",
    };
    const textColors = overlayElementTextColors("emote_slots.slot", {}, elementStyle, {});
    const ratios = textColors.flatMap((color) => {
      const ratio = overlayAppearanceContrastRatio(color, "#555555");
      return ratio === null ? [] : [ratio];
    });

    expect(textColors).toContain("#777777");
    expect(Math.min(...ratios)).toBeLessThan(4.5);
  });

  it("includes quiz correct-answer and song requester text in contrast checks", () => {
    const quizColors = overlayElementTextColors("quiz.session", { correctColor: "#10141b" }, { color: "#ffffff" }, { background: { color: "#10141b", opacityPercent: 100 } });
    const uppercaseQuizColors = overlayElementTextColors("quiz.session", { correctColor: "#ABCDEF" }, {}, {});
    const requesterColors = overlayElementTextColors("song_requests.now_playing", {}, {}, {});
    const styledRequesterColors = overlayElementTextColors("song_requests.now_playing", {}, { secondaryTextColor: "#445566" }, {});

    expect(quizColors).toContain("#10141b");
    expect(uppercaseQuizColors).toContain("#abcdef");
    expect(requesterColors).toContain("#a8b2c1");
    expect(styledRequesterColors).toContain("#445566");
    expect(styledRequesterColors).not.toContain("#a8b2c1");
  });

  it("keeps a legacy color visible above an existing overlay style after migration", () => {
    const overlayStyle = { color: "#ffffff", background: { color: "#202020", opacityPercent: 100 } };
    const legacyConfig = { textColor: "#222222", backgroundColor: "#111111", showPercent: false };
    const before = resolveOverlayElementColors("quiz.session", legacyConfig, {}, overlayStyle);
    const migrated = migrateLegacyOverlayStyles([
      { id: "quiz-inherited", kind: "quiz.session", config: legacyConfig },
    ], { overlay: overlayStyle, elements: {} });
    const after = resolveOverlayElementColors("quiz.session", migrated.elements[0]?.config ?? {}, migrated.styles.elements["quiz-inherited"] ?? {}, migrated.styles.overlay);

    expect(after).toEqual(before);
    expect(migrated.elements[0]?.config).toEqual({ showPercent: false });
    expect(migrated.styles.elements["quiz-inherited"]).toEqual({
      color: "#222222",
      background: { color: "#111111", opacityPercent: 100 },
    });
  });

  it("migrates null alert text to its default without changing the saved font size", () => {
    const element = { id: "alert-null-text", kind: "overlay_alerts.alert", config: { textColor: null, fontSize: 56 } };
    const overlay = { color: "#123456" };
    const before = resolveOverlayElementColors(element.kind, element.config, {}, overlay);
    const migrated = migrateLegacyOverlayStylesToCss("", [element], { overlay, elements: {} });

    expect(migrated).not.toBeNull();
    if (migrated === null) throw new Error("The alert's legacy color did not produce valid CSS.");
    const after = resolveOverlayElementColors(
      element.kind,
      migrated.elements[0]?.config ?? {},
      migrated.styles.elements["alert-null-text"] ?? {},
      migrated.styles.overlay,
    );

    expect(before.text).toBe("#ffffff");
    expect(after.text).toBe(before.text);
    expect(migrated.elements[0]?.config).toEqual({ fontSize: 56 });
  });

  it("preserves every effective color across legacy, element, and overlay combinations", () => {
    const properties = [
      { kind: "quiz.session", legacyKey: "textColor", styleKey: "color", resultKey: "text", defaultColor: "#f2f5f9" },
      { kind: "quiz.session", legacyKey: "backgroundColor", styleKey: "background", resultKey: "background", defaultColor: "#10141b" },
      { kind: "quiz.session", legacyKey: "secondaryColor", styleKey: "secondaryTextColor", resultKey: "secondaryText", defaultColor: "#a8b2c1" },
      { kind: "quiz.session", legacyKey: "accentColor", styleKey: "accentColor", resultKey: "accent", defaultColor: "#5fa4ff" },
      { kind: "emote_slots.slot", legacyKey: "textColor", styleKey: "color", resultKey: "text", defaultColor: "#f2f5f9" },
      { kind: "emote_slots.slot", legacyKey: "backgroundColor", styleKey: "background", resultKey: "background", defaultColor: "#090c10" },
      { kind: "emote_slots.slot", legacyKey: "secondaryColor", styleKey: "secondaryTextColor", resultKey: "secondaryText", defaultColor: "#c9d1db" },
      { kind: "emote_slots.slot", legacyKey: "highlightColor", styleKey: "accentColor", resultKey: "accent", defaultColor: "#2ed3a3" },
      { kind: "overlay_alerts.alert", legacyKey: "textColor", styleKey: "color", resultKey: "text", defaultColor: "#ffffff" },
    ] as const;
    const legacyValues = [undefined, null, "#222222"] as const;
    const overlayValues = [undefined, "#ffffff"] as const;
    const elementValues = [undefined, "#111111"] as const;
    const styleValue = (styleKey: typeof properties[number]["styleKey"], value: string): OverlayStyleDocument["overlay"] =>
      styleKey === "background" ? { background: { color: value, opacityPercent: 100 } } : { [styleKey]: value };

    for (const property of properties) {
      for (const legacyValue of legacyValues) {
        for (const overlayValue of overlayValues) {
          for (const elementValue of elementValues) {
            const config = legacyValue === undefined ? {} : { [property.legacyKey]: legacyValue };
            const overlay = overlayValue === undefined ? {} : styleValue(property.styleKey, overlayValue);
            const element = elementValue === undefined ? {} : styleValue(property.styleKey, elementValue);
            const before = resolveOverlayElementColors(property.kind, config, element, overlay)[property.resultKey];
            const migrated = migrateLegacyOverlayStylesToCss("", [
              { id: "matrix-element", kind: property.kind, config },
            ], { overlay, elements: { "matrix-element": element } });
            expect(migrated, JSON.stringify({ ...property, legacyValue, overlayValue, elementValue })).not.toBeNull();
            if (migrated === null) throw new Error("The migrated style document did not produce valid CSS.");
            const after = resolveOverlayElementColors(
              property.kind,
              migrated.elements[0]?.config ?? {},
              migrated.styles.elements["matrix-element"] ?? {},
              migrated.styles.overlay,
            )[property.resultKey];

            expect(after?.toLowerCase(), JSON.stringify({ ...property, legacyValue, overlayValue, elementValue })).toBe(before?.toLowerCase());
            if (legacyValue === null && elementValue === undefined) {
              expect(before?.toLowerCase(), JSON.stringify({ ...property, overlayValue })).toBe(property.defaultColor);
            }
            if (legacyValue === "#222222" && elementValue === undefined) {
              const migratedElement = migrated.styles.elements["matrix-element"];
              expect(property.styleKey === "background" ? migratedElement?.background?.color : migratedElement?.[property.styleKey]).toBe("#222222");
            }
            if (legacyValue !== undefined) expect(migrated.elements[0]?.config).not.toHaveProperty(property.legacyKey);
          }
        }
      }
    }
  });

  it("commits legacy migration only when a valid runtime style block was written", () => {
    const elements = [{ id: "legacy-quiz", kind: "quiz.session", config: { textColor: "#223344", showPercent: false } }];
    const duplicateMarkers = `${OVERLAY_STYLE_BEGIN_MARKER}\n${OVERLAY_STYLE_END_MARKER}\n${OVERLAY_STYLE_BEGIN_MARKER}\n${OVERLAY_STYLE_END_MARKER}`;

    expect(migrateLegacyOverlayStylesToCss(duplicateMarkers, elements, { overlay: {}, elements: {} })).toBeNull();

    const valid = migrateLegacyOverlayStylesToCss("", elements, { overlay: {}, elements: {} });
    expect(valid).not.toBeNull();
    expect(valid?.elements[0]?.config).toEqual({ showPercent: false });
    expect(parseOverlayStyleBlock(valid?.css ?? "")).toMatchObject({
      kind: "valid",
      styles: { elements: { "legacy-quiz": { color: "#223344" } } },
    });
  });

  it("keeps twenty fully styled elements under the CSS limit with a stable compact block", () => {
    const styles: OverlayStyleDocument = {
      overlay: {},
      elements: Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => {
        const suffix = String(index).padStart(2, "0");
        return [`element-${suffix}`, {
      fontFamily: "Arial",
          fontSize: 20 + index,
          fontWeight: ([400, 500, 600, 700] as const)[index % 4] ?? 400,
          color: `#${(0x120000 + index * 0x101).toString(16).padStart(6, "0")}`,
          secondaryTextColor: `#${(0x230000 + index * 0x101).toString(16).padStart(6, "0")}`,
          accentColor: `#${(0x340000 + index * 0x101).toString(16).padStart(6, "0")}`,
          textAlign: (["left", "center", "right"] as const)[index % 3] ?? "left",
          lineHeight: 1 + index / 20,
          letterSpacing: index / 10,
          stroke: { width: 1 + index / 10, color: "#000000" },
          shadow: { x: index / 10, y: 2, blur: 4 + index / 10, color: "#010203" },
          background: { color: `#${(0x450000 + index * 0x101).toString(16).padStart(6, "0")}`, opacityPercent: 40 + index },
          padding: 8 + index / 10,
          borderRadius: 12 + index / 10,
        }];
      })),
    };
    const block = generateOverlayStyleBlock(styles);
    const parsed = parseOverlayStyleBlock(block);

    expect(block.length).toBeLessThanOrEqual(OVERLAY_CSS_MAXIMUM_LENGTH);
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error("The compact style block did not parse.");
    expect(generateOverlayStyleBlock(parsed.styles)).toHaveLength(block.length);
    const unchanged = migrateLegacyOverlayStylesToCss(block, Array.from({ length: 20 }, (_unused, index) => ({
      id: `element-${String(index).padStart(2, "0")}`,
      kind: "text_library.block",
      config: {},
    })), parsed.styles);
    expect(unchanged).not.toBeNull();
    expect(unchanged?.css.length).toBeLessThanOrEqual(block.length);
    expect(unchanged?.css.length).toBeLessThanOrEqual(OVERLAY_CSS_MAXIMUM_LENGTH);
    expect(block.match(/\[data-element="element-\d+"\] \{/gu)).toHaveLength(20);
    expect(block.match(/:is\(\[data-element=/gu)).toHaveLength(1);
    expect(block).toContain("font-size: var(--brobot-overlay-font-size);");
  });

  it("keeps managed text color ahead of earlier user CSS after open and save", () => {
    const previousBlock = `${OVERLAY_STYLE_BEGIN_MARKER}\n[data-element="element-a"] :where(.brobot-variable, .brobot-module-text) {\n  font-size: 32px;\n  color: #008000;\n}\n${OVERLAY_STYLE_END_MARKER}`;
    const original = `.brobot-variable { color: #ff0000; }\n${previousBlock}`;
    const parsed = parseOverlayStyleBlock(original);
    if (parsed.kind !== "valid") throw new Error("Previous style block did not parse.");
    const saved = replaceOverlayStyleBlock(original, parsed.styles, ["element-a"]);
    const renderTextColor = (css: string): string | undefined => {
      const testDocument = document as unknown as {
        createElement: (tagName: string) => HTMLElement;
        head: { appendChild: (node: Node) => unknown };
        body: { appendChild: (node: Node) => unknown };
      };
      const sheet = testDocument.createElement("style") as HTMLStyleElement;
      sheet.textContent = css;
      const root = testDocument.createElement("div");
      root.className = "brobot-overlay";
      root.innerHTML = '<div data-element="element-a"><span class="brobot-variable"></span></div>';
      testDocument.head.appendChild(sheet);
      testDocument.body.appendChild(root);
      const text = root.querySelector<HTMLElement>(".brobot-variable");
      if (text === null) return undefined;
      let color: string | undefined;
      try {
        for (const rule of Array.from(sheet.sheet?.cssRules ?? [])) {
          if (!(rule instanceof CSSStyleRule) || !rule.style.getPropertyValue("color")) continue;
          if (!rule.selectorText.split(",").some((selector) => text.matches(selector.trim()))) continue;
          const declaration = rule.style.getPropertyValue("color").trim();
          const variable = /^var\((--[a-z-]+)\)$/u.exec(declaration)?.[1];
          const rendered = variable === undefined
            ? declaration
            : getComputedStyle(text.parentElement ?? root).getPropertyValue(variable).trim();
          const probe = testDocument.createElement("span");
          probe.style.color = rendered;
          color = getComputedStyle(probe).color;
        }
      } finally {
        sheet.remove();
        root.remove();
      }
      return color;
    };

    expect(renderTextColor(original)).toBe("rgb(0, 128, 0)");
    expect(renderTextColor(saved)).toBe("rgb(0, 128, 0)");
  });

  it("parses, edits, and saves element styles for prototype-named IDs", () => {
    const originalStyles: OverlayStyleDocument = {
      overlay: {},
      elements: {
        constructor: { color: "#112233" },
        toString: { fontSize: 32 },
      },
    };
    const parsed = parseOverlayStyleBlock(generateOverlayStyleBlock(originalStyles));
    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error("Styles for prototype-named IDs did not parse.");

    const saved = replaceOverlayStyleBlock("", {
      ...parsed.styles,
      elements: {
        ...parsed.styles.elements,
        constructor: { color: "#abcdef" },
        toString: { fontSize: 48 },
      },
    }, ["constructor", "toString"]);

    expect(parseOverlayStyleBlock(saved)).toMatchObject({
      kind: "valid",
      styles: { elements: { constructor: { color: "#abcdef" }, toString: { fontSize: 48 } } },
    });
  });

  it("round-trips overlay and element styles through its deterministic CSS format", () => {
    const block = generateOverlayStyleBlock(styles);
    const parsed = parseOverlayStyleBlock(block);

    expect(parsed.kind).toBe("valid");
    if (parsed.kind !== "valid") throw new Error("Generated style block did not parse.");
    expect(parsed.styles).toEqual({
      overlay: styles.overlay,
      elements: styles.elements,
    });
    expect(block.indexOf("font-family:")).toBeLessThan(block.indexOf("font-size:"));
    expect(block.indexOf("font-size:")).toBeLessThan(block.indexOf("font-weight:"));
    expect(block.indexOf("element_a")).toBeLessThan(block.indexOf("element_b"));
  });

  it("targets the rendered variable text for overlay and element styles", () => {
    const content = generateOverlayStyleContent(styles);

    expect(content).toContain(".brobot-overlay {");
    expect(content).toContain(".brobot-overlay :where(.brobot-variable, .brobot-module-text) {");
    expect(content).toContain('[data-element="element_a"] {');
    expect(content).toContain('[data-element="element_b"] {');
    expect(content).toContain('[data-element="element_a"] :where(.brobot-variable, .brobot-module-text) {');
    expect(content).toContain("--brobot-overlay-text-color: #abcdef;");
    expect(content).toContain("--brobot-overlay-secondary-text-color: #334455;");
    expect(content).toContain("--brobot-overlay-accent-color: #667788;");
  });

  it("reads the previous managed selector format and migrates it on the next write", () => {
    const prefix = "/* saved overlay */\n";
    const previousBlock = `${OVERLAY_STYLE_BEGIN_MARKER}\n.brobot-overlay :where(.brobot-variable) {\n  font-size: 32px;\n  color: #ffffff;\n  text-align: center;\n}\n\n.brobot-overlay .brobot-overlay-composition-element {\n  --brobot-overlay-anchor-x: -50%;\n}\n\n[data-element="element_a"] :where(.brobot-variable) {\n  font-weight: 700;\n  color: #abcdef;\n}\n${OVERLAY_STYLE_END_MARKER}`;
    const suffix = "\n/* user CSS */\n.brobot-overlay { opacity: 1; }";
    const original = `${prefix}${previousBlock}${suffix}`;
    const parsed = parseOverlayStyleBlock(original);

    expect(parsed).toMatchObject({
      kind: "valid",
      styles: {
        overlay: { fontSize: 32, color: "#ffffff", textAlign: "center" },
        elements: { element_a: { fontWeight: 700, color: "#abcdef" } },
      },
    });
    if (parsed.kind !== "valid") throw new Error("Previous style block did not parse.");

    const migrated = replaceOverlayStyleBlock(original, parsed.styles, ["element_a"]);

    expect(migrated.startsWith(prefix)).toBe(true);
    expect(migrated.endsWith(suffix)).toBe(true);
    expect(migrated).toContain(".brobot-overlay {");
    expect(migrated).toContain('[data-element="element_a"] {');
    expect(migrated).not.toContain(":where(.brobot-variable) {");
    expect(parseOverlayStyleBlock(migrated).kind).toBe("valid");
  });

  it("round-trips every integer background opacity percentage", () => {
    for (let opacityPercent = 0; opacityPercent <= 100; opacityPercent += 1) {
      const block = generateOverlayStyleBlock({
        overlay: { background: { color: "#123456", opacityPercent } },
        elements: {},
      });
      const parsed = parseOverlayStyleBlock(block);

      expect(parsed, `opacity ${String(opacityPercent)}% should parse`).toMatchObject({
        kind: "valid",
        styles: { overlay: { background: { color: "#123456", opacityPercent } } },
      });
    }
  });

  it.each([
    ["overlay wrappers", `${OVERLAY_STYLE_BEGIN_MARKER}\n.brobot-overlay {\n  color: #ffffff;\n}\n${OVERLAY_STYLE_END_MARKER}`],
    ["element wrappers", `${OVERLAY_STYLE_BEGIN_MARKER}\n[data-element="element-a"] {\n  font-size: 32px;\n}\n${OVERLAY_STYLE_END_MARKER}`],
  ])("locks legacy %s targets as hand-edited CSS", (_description, legacyBlock) => {
    expect(parseOverlayStyleBlock(legacyBlock).kind).toBe("invalid");
  });

  it.each([
    ["left", "0%"],
    ["center", "-50%"],
    ["right", "-100%"],
  ] as const)("writes the %s composition anchor from managed alignment", (alignment, translation) => {
    const content = generateOverlayStyleContent({ overlay: {}, elements: { "element-a": { textAlign: alignment } } });

    expect(content).toContain(`[data-element="element-a"] {\n  --brobot-overlay-text-align: ${alignment};\n  --brobot-overlay-anchor-x: ${translation};\n}`);
    expect(parseOverlayStyleBlock(generateOverlayStyleBlock({ overlay: {}, elements: { "element-a": { textAlign: alignment } } }))).toMatchObject({
      kind: "valid",
      styles: { elements: { "element-a": { textAlign: alignment } } },
    });
  });

  it("keeps every byte outside the managed markers when rewriting the block", () => {
    const prefix = "/* custom header */\r\n";
    const suffix = "\r\n[data-element=\"element_a\"] .brobot-variable__value { color: gold; }\r\n";
    const original = `${prefix}${generateOverlayStyleBlock(styles)}${suffix}`;
    const rewritten = replaceOverlayStyleBlock(original, { ...styles, overlay: { color: "#123456" } }, ["element_a"]);
    const originalOutside = `${original.slice(0, original.indexOf(OVERLAY_STYLE_BEGIN_MARKER) + OVERLAY_STYLE_BEGIN_MARKER.length)}${original.slice(original.indexOf(OVERLAY_STYLE_END_MARKER))}`;
    const rewrittenOutside = `${rewritten.slice(0, rewritten.indexOf(OVERLAY_STYLE_BEGIN_MARKER) + OVERLAY_STYLE_BEGIN_MARKER.length)}${rewritten.slice(rewritten.indexOf(OVERLAY_STYLE_END_MARKER))}`;

    expect(rewrittenOutside).toBe(originalOutside);
    expect(rewritten.endsWith(suffix)).toBe(true);
    expect(rewritten).not.toContain("element_b");
    expect(parseOverlayStyleBlock(rewritten).kind).toBe("valid");
  });

  it("locks edited or unknown declarations and allows the editor to rewrite them", () => {
    const block = generateOverlayStyleBlock(styles);
    const edited = block.replace("color: #ffffff;", "color: hotpink;");
    const unknown = block.replace("color: #ffffff;", "outline: 2px solid red;");

    expect(parseOverlayStyleBlock(edited).kind).toBe("invalid");
    expect(parseOverlayStyleBlock(unknown).kind).toBe("invalid");
    const restored = replaceOverlayStyleBlock(unknown, styles, ["element_a", "element_b"]);
    expect(parseOverlayStyleBlock(restored).kind).toBe("valid");
    expect(restored).toContain("color: #ffffff;");
  });

  it("distinguishes a missing block from an empty managed block", () => {
    expect(parseOverlayStyleBlock(".custom { color: gold; }\n")).toEqual({ kind: "missing" });
    const empty = generateOverlayStyleBlock({ overlay: {}, elements: {} });
    const parsed = parseOverlayStyleBlock(empty);
    expect(parsed).toMatchObject({ kind: "valid", styles: { overlay: {}, elements: {} } });
    const onlyElementA = Object.fromEntries(Object.entries(styles.elements).filter(([id]) => id === "element_a"));
    expect(replaceOverlayStyleBlock(".custom { color: gold; }", styles, ["element_a"])).toBe(
      `${generateOverlayStyleBlock({ overlay: styles.overlay, elements: onlyElementA })}\n.custom { color: gold; }`,
    );
  });

  it("preserves custom CSS outside a manually edited block while restoring the generated body", () => {
    const customCss = "\n.brobot-overlay { color: gold; }";
    const edited = `${OVERLAY_STYLE_BEGIN_MARKER}\n.brobot-overlay {\n  color: gold;\n}\n${OVERLAY_STYLE_END_MARKER}${customCss}`;
    const rewritten = replaceOverlayStyleBlock(edited, styles, ["element_a"]);

    expect(rewritten.endsWith(customCss)).toBe(true);
    expect(rewritten.slice(rewritten.indexOf(OVERLAY_STYLE_END_MARKER))).toBe(edited.slice(edited.indexOf(OVERLAY_STYLE_END_MARKER)));
    expect(parseOverlayStyleBlock(rewritten).kind).toBe("valid");
    expect(generateOverlayStyleContent({ overlay: {}, elements: {} })).toBe("");
  });
});
