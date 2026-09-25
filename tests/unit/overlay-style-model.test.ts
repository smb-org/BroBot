import { describe, expect, it } from "vitest";

import {
  OVERLAY_STYLE_BEGIN_MARKER,
  OVERLAY_STYLE_END_MARKER,
  generateOverlayStyleBlock,
  generateOverlayStyleContent,
  parseOverlayStyleBlock,
  replaceOverlayStyleBlock,
  type OverlayStyleDocument,
} from "../../src/dashboard/overlay-style-model";

const styles: OverlayStyleDocument = {
  overlay: {
    fontFamily: "Inter",
    fontSize: 32,
    fontWeight: 600,
    color: "#ffffff",
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
    element_b: { fontFamily: "A \"quoted\" font", fontSize: 64, color: "#ffcc00", textAlign: "right" },
    element_a: { fontWeight: 700, color: "#abcdef" },
  },
};

describe("overlay style block model", () => {
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
