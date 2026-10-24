import { describe, expect, it } from "vitest";

import { isMessageEnabled } from "../../src/contracts/message-enabled";

describe("isMessageEnabled", () => {
  it("uses an explicit disabled flag even when the saved text is non-empty", () => {
    expect(isMessageEnabled({ announcement: "Saved text", announcementEnabled: false }, "announcement", "announcementEnabled"))
      .toBe(false);
  });

  it("uses an explicit enabled flag even when the text is empty", () => {
    expect(isMessageEnabled({ announcement: "", announcementEnabled: true }, "announcement", "announcementEnabled"))
      .toBe(true);
  });

  it.each([
    ["non-empty legacy text", "Saved text", true],
    ["blank legacy text", "  \n", false],
  ] as const)("derives the state from %s when the flag is missing", (_name, text, enabled) => {
    expect(isMessageEnabled({ announcement: text }, "announcement", "announcementEnabled")).toBe(enabled);
  });

  it("resolves a selected variant switch independently and derives missing array flags", () => {
    const settings = { variants: ["Saved one", "Saved two"], variantsEnabled: [true, false] };

    expect(isMessageEnabled(settings, "variants", "variantsEnabled", 0)).toBe(true);
    expect(isMessageEnabled(settings, "variants", "variantsEnabled", 1)).toBe(false);
    expect(isMessageEnabled({ variants: ["Saved one", ""] }, "variants", "variantsEnabled", 0)).toBe(true);
    expect(isMessageEnabled({ variants: ["Saved one", ""] }, "variants", "variantsEnabled", 1)).toBe(false);
  });
});
