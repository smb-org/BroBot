import { describe, expect, it } from "vitest";

import type { TextBlockVariant } from "../../src/modules/text_library/contracts";
import { estimateEmbeddedBlockOverflow } from "../../src/modules/text_library/panel/embedded-block-overflow";

const variant = (text: string): TextBlockVariant => ({ id: "default", conditions: {}, texts: [text] });

describe("embedded text block length warnings", () => {
  it("does not warn when a long built-in variable is not an embedded text block", () => {
    const warning = estimateEmbeddedBlockOverflow(
      ["🌙 Es ist Nacht, Sonnenaufgang um {sun.rise}"],
      new Map(),
      [{ name: "sun.rise", maxLength: 645 }],
    );

    expect(warning).toBeNull();
  });

  it("does not warn when the referenced block expansion stays within 500 characters", () => {
    const blocks = new Map<string, readonly TextBlockVariant[]>([["welcome", [variant("Hello")]]]);

    expect(estimateEmbeddedBlockOverflow([`${"x".repeat(480)}{welcome}`], blocks, [])).toBeNull();
  });

  it("warns only when an embedded block makes a variant exceed 500 and names that block", () => {
    const blocks = new Map<string, readonly TextBlockVariant[]>([["welcome", [variant("y".repeat(30))]]]);

    expect(estimateEmbeddedBlockOverflow([`${"x".repeat(480)}{welcome}`], blocks, [])).toEqual({
      length: 510,
      blockNames: ["welcome"],
    });
  });

  it("does not blame a text block when variables alone can exceed the chat limit", () => {
    const blocks = new Map<string, readonly TextBlockVariant[]>([["welcome", [variant("Hello")]]]);

    expect(estimateEmbeddedBlockOverflow(
      [`${"x".repeat(460)}{sun.rise} {welcome}`],
      blocks,
      [{ name: "sun.rise", maxLength: 645 }],
    )).toBeNull();
  });
});
